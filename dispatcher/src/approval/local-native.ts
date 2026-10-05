import {rotateProtectedKeys} from "./local-key-rotation.js";
import {invalidateLocalApprovals} from "./local-invalidation.js";
import {LocalMaintenanceStore,encodeLocalMaintenance} from "./local-maintenance.js";
import {withSecurityTransactionLock} from "../audit/coordination.js";
import fs from "node:fs";
import path from "node:path";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {z} from "zod";
import type Database from "better-sqlite3";
import {NativeKeychainPort} from "./native-keychain-port.js";
import {encodeKeychainCasRequest,parseKeychainCasResponse,type KeychainCasScope} from "./keychain-cas.js";
import {ProtectedAuditAnchors,ProtectedClockMarks,encodeProtectedHead,type ProtectedHeadPort,type ProtectedHeadEntry} from "./protected-heads.js";
import {SqliteUsedTransactionNodes,installUsedTransactionNodeSchema} from "./used-transaction-store.js";
import {emptyUsedTransactionRoot,prepareUsedTransactionInsert} from "./used-transactions.js";
import {advanceClockMark} from "./clock.js";
import {NativeClockSource} from "./native-clock.js";
import {openSecurityDatabase} from "../audit/coordination.js";
import {AuditRepository,installAuditSchema} from "../audit/repository.js";
import {signAuditCheckpoint,type AuditKey,type AuditEvent} from "../audit/codec.js";
import {ApprovalTransaction,type ApprovalTransactionProviders} from "./transaction.js";
import {installApprovalSchema,installApprovalMetadataSchema,installApprovalIndexSchema,installApprovalPayloadSchema,installApprovalExecutionMarkerSchema} from "./schema.js";
import {ApprovalMetadataNodes} from "./metadata-store.js";
import {ApprovalIndexBlobs} from "./index-store.js";
import {ApprovalMetadataPlan} from "./metadata-plan.js";
import {ApprovalMetadataPlanWriter} from "./metadata-plan-store.js";
import {emptyMetadataRoot} from "./metadata-tree.js";
import type {ApprovalRecordKind} from "./record-codec.js";
import type {ExternalApprovalKeys} from "./local-external-service.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const localApprovalNativeConfigSchema=z.strictObject({codec_version:z.literal(1),scope:z.strictObject({instance_id:id,workspace_id:id}),owner_id:id,
 ledger_id:id,access_group:z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/),used_nodes_database:z.string().refine(v=>path.isAbsolute(v)&&path.normalize(v)===v),
 slack_workspace_alias:id,key_version:positive});
export type LocalApprovalNativeConfig=z.infer<typeof localApprovalNativeConfigSchema>;
const keySchema=z.strictObject({codec_version:z.literal(1),version:positive,purpose:z.enum(["audit","approval_content","approval_payload_wrap","approval_notification_marker","approval_execution_marker"]),
 state:z.enum(["active","verification_only","revoked"]),activated_at:z.iso.datetime(),signing_expires_at:z.iso.datetime(),secret_hex:z.string().regex(/^[a-f0-9]{64}$/)});
const maintenanceAccess=Symbol("local_operator_maintenance");
const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const headScope=(c:LocalApprovalNativeConfig,purpose:"clock_mark"|"audit_anchor")=>({instance_id:c.scope.instance_id,ledger_id:c.ledger_id,purpose});
const casScope=(c:LocalApprovalNativeConfig,purpose:"clock_mark"|"audit_anchor"):KeychainCasScope=>({access_group:c.access_group,instance_id:"head_"+digest(headScope(c,purpose)),purpose});
const keyScope=(c:LocalApprovalNativeConfig,purpose:string,version:number):KeychainCasScope=>({access_group:c.access_group,instance_id:"key_"+digest(["local_operator_v1",c.scope,purpose,version]),purpose:"approval_key"});
const maintenanceScope=(c:LocalApprovalNativeConfig):KeychainCasScope=>({access_group:c.access_group,instance_id:"maintenance_"+digest([c.scope,c.ledger_id]),purpose:"policy_generation"});
class HeadPort implements ProtectedHeadPort {
 constructor(private readonly port:NativeKeychainPort,private readonly scope:KeychainCasScope){}
 read():ProtectedHeadEntry{const r=parseKeychainCasResponse(this.port.exchange(encodeKeychainCasRequest(this.scope)));if(r.status!=="observed")throw Error("approval_protected_head_unavailable");return {revision:r.revision,value:Buffer.from(r.value,"base64").toString("utf8")};}
 compareExchange(expected:ProtectedHeadEntry,proposed:string){const r=parseKeychainCasResponse(this.port.exchange(encodeKeychainCasRequest(this.scope,{revision:expected.revision,value:Buffer.from(expected.value)},Buffer.from(proposed))));if(r.status!=="changed")throw Error("approval_protected_head_unavailable");return {revision:r.revision,value:Buffer.from(r.value,"base64").toString("utf8")};}
}
export function readLocalApprovalNativeConfig(file:string):LocalApprovalNativeConfig{
 try{
  if(!path.isAbsolute(file)||path.normalize(file)!==file)throw Error();
  for(let dir=path.dirname(file);;dir=path.dirname(dir)){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid?.()].includes(s.uid)||(s.mode&0o022)!==0)throw Error();if(dir===path.dirname(dir))break;}
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16384)throw Error();return localApprovalNativeConfigSchema.parse(JSON.parse(fs.readFileSync(fd,"utf8")));}finally{fs.closeSync(fd);}
 }catch{throw Error("local_approval_config_unavailable");}
}
/** PR #362のnative port/protected-head構成を再利用。DB本体はcallerが所有する。
 * constructorは鍵、schema、genesis、used-node DBを作成しない。 */
export class NativeLocalApprovalConnection {
 readonly maintenance:LocalMaintenanceStore;readonly config:LocalApprovalNativeConfig;readonly providers:ApprovalTransactionProviders;readonly keys:ExternalApprovalKeys;
 private readonly native:NativeKeychainPort;private readonly nodesDb:Database.Database;
 constructor(readonly db:Database.Database,input:LocalApprovalNativeConfig,access?:typeof maintenanceAccess){
  this.config=localApprovalNativeConfigSchema.parse(input);const opened:{close():void}[]=[];
  try{
   this.native=new NativeKeychainPort();opened.push(this.native);
   this.maintenance=new LocalMaintenanceStore(new HeadPort(this.native,maintenanceScope(this.config)));if(access!==maintenanceAccess)this.maintenance.requireReady(this.config.key_version);
   this.nodesDb=openSecurityDatabase(this.config.used_nodes_database);opened.push(this.nodesDb);this.nodesDb.pragma("synchronous=FULL");
   const main=fs.statSync(db.name),aux=fs.statSync(this.config.used_nodes_database);if(main.dev===aux.dev&&main.ino===aux.ino)throw Error();
   const nodes=new SqliteUsedTransactionNodes(this.nodesDb),c=this.config;
   const read=(purpose:z.infer<typeof keySchema>["purpose"],version:number)=>{
    if(access!==maintenanceAccess)this.maintenance.requireReady(c.key_version);
    const r=parseKeychainCasResponse(this.native.exchange(encodeKeychainCasRequest(keyScope(c,purpose,version))));if(r.status!=="observed")throw Error("local_approval_key_unavailable");
    const key=keySchema.parse(JSON.parse(Buffer.from(r.value,"base64").toString("utf8")));if(key.version!==version||key.purpose!==purpose)throw Error("local_approval_key_unavailable");
    return {purpose,version,state:key.state,activated_at:key.activated_at,signing_expires_at:key.signing_expires_at,secret:Buffer.from(key.secret_hex,"hex")};
   };
   this.providers={clock:new NativeClockSource(),clockMarks:new ProtectedClockMarks(headScope(c,"clock_mark"),new HeadPort(this.native,casScope(c,"clock_mark")),nodes),
    auditAnchors:new ProtectedAuditAnchors(headScope(c,"audit_anchor"),new HeadPort(this.native,casScope(c,"audit_anchor")),nodes),auditKeys:v=>read("audit",v) as AuditKey,
    auditSigningKeyVersion:c.key_version,maximumClockDriftMs:5000,lockWaitTimeoutMs:1000};
   this.keys={content:v=>({...read("approval_content",v??c.key_version),purpose:"approval_content"}),wrapping:()=>({...read("approval_payload_wrap",c.key_version),purpose:"approval_payload_wrap"}),
    notification:()=>({...read("approval_notification_marker",c.key_version),purpose:"approval_notification_marker"}),wrappingVersion:v=>({...read("approval_payload_wrap",v??c.key_version),purpose:"approval_payload_wrap"}),
    notificationVersion:v=>({...read("approval_notification_marker",v),purpose:"approval_notification_marker"}),execution:v=>({...read("approval_execution_marker",v??c.key_version),purpose:"approval_execution_marker"})};
   this.providers.clockMarks.read();this.providers.auditAnchors.read();
   for(const readKey of [()=>this.keys.content(null),()=>this.keys.wrapping(),()=>this.keys.notification(),()=>this.keys.execution(null)])readKey();
  }catch{for(const item of opened.reverse())item.close();throw Error("local_approval_native_unavailable");}
 }
 doctor(){try{new AuditRepository(this.db,this.providers.auditAnchors,this.providers.auditKeys).verify();const mark=this.providers.clockMarks.read(),observation=this.providers.clock.observe();
   advanceClockMark(mark,observation,"doctor_"+randomUUID().replaceAll("-",""),this.providers.maximumClockDriftMs);
   const keys=[this.keys.content(null),this.keys.wrapping(),this.keys.notification(),this.keys.execution(null),this.providers.auditKeys(this.config.key_version)];
   for(const key of keys)if(!key||key.state!=="active"||key.signing_expires_at<=observation.wall_utc)throw Error();
   const expires=keys.map(key=>key!.signing_expires_at).sort()[0]!;return {ready:true as const,instance_id:this.config.scope.instance_id,workspace_id:this.config.scope.workspace_id,key_expires_at:expires,rotation_due:Date.parse(expires)-Date.parse(observation.wall_utc)<=14*86400000};
  }catch{return {ready:false as const,reason:"protected_state_unverified"};}}
 close(){this.nodesDb.close();this.native.close();}
}

/** 人がMacのTTY上でexact instance/workspace/ownerを確認した初回のみ。
 * 部分失敗は停止し、同じscopeの再初期化・自動修復・旧root再生成はしない。 */
export function provisionNativeLocalApproval(db:Database.Database,input:LocalApprovalNativeConfig,confirmation:string):void {
 const c=localApprovalNativeConfigSchema.parse(input);
 if(process.platform!=="darwin"||!process.stdin.isTTY||process.getuid?.()!==process.geteuid?.()||confirmation!==`${c.scope.instance_id}/${c.scope.workspace_id}/${c.owner_id}`)throw Error("local_approval_operator_confirmation_required");
 if(fs.existsSync(c.used_nodes_database))throw Error("local_approval_already_provisioned");
 for(const table of ["security_audit_checkpoint","security_audit_records","approval_requests"]){if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)&&db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw Error("local_approval_already_provisioned");}
 const native=new NativeKeychainPort(),clock=new NativeClockSource(),observation=clock.observe();let nodesDb:Database.Database|undefined;
 try{
  const fd=fs.openSync(c.used_nodes_database,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.closeSync(fd);
  nodesDb=openSecurityDatabase(c.used_nodes_database);nodesDb.pragma("synchronous=FULL");installUsedTransactionNodeSchema(nodesDb);const nodes=new SqliteUsedTransactionNodes(nodesDb);
  const keys=new Map<string,z.infer<typeof keySchema>>();
  for(const purpose of keySchema.shape.purpose.options){const key={codec_version:1 as const,purpose,version:c.key_version,state:"active" as const,activated_at:observation.wall_utc,
    signing_expires_at:new Date(Date.parse(observation.wall_utc)+89*86400000).toISOString(),secret_hex:randomBytes(32).toString("hex")};keys.set(purpose,key);native.provision(keyScope(c,purpose,c.key_version),Buffer.from(JSON.stringify(key)));}
  native.provision(maintenanceScope(c),Buffer.from(encodeLocalMaintenance({codec_version:1,active_key_version:c.key_version,phase:"ready",operation_id:null,next_key_version:null,recovery_mark:null})));
  const key=keys.get("audit")!,auditKey={...key,secret:Buffer.from(key.secret_hex,"hex")} as AuditKey;
  const checkpoint=signAuditCheckpoint({codec_version:1,chain_id:"local_"+randomUUID().replaceAll("-",""),transaction_id:"genesis",signed_at:observation.wall_utc,key_version:c.key_version},()=>auditKey);
  for(const purpose of ["clock_mark","audit_anchor"] as const){const identity=headScope(c,purpose),reservation=purpose==="clock_mark"?"initial_mark":"genesis";
   const insertion=prepareUsedTransactionInsert(identity,emptyUsedTransactionRoot(identity),reservation,digest=>nodes.read(digest));nodes.stage(insertion.nodes);
   const state=purpose==="clock_mark"?{codec_version:1,transaction_id:reservation,previous_transaction_id:null,boot_id:observation.boot_id,continuous_ms:observation.continuous_ms,effective_utc:observation.wall_utc}
    :{chain_id:checkpoint.chain_id,sequence:0,mac:"0".repeat(64),checkpoint_mac:checkpoint.mac,pending_transaction_id:null};
   native.provision(casScope(c,purpose),Buffer.from(encodeProtectedHead({codec_version:1,kind:purpose,scope:identity,used_root:insertion.proposed_root,last_reservation_id:reservation,state})));
  }
  installAuditSchema(db);installApprovalSchema(db);installApprovalMetadataSchema(db);installApprovalIndexSchema(db);installApprovalPayloadSchema(db);installApprovalExecutionMarkerSchema(db);
  nodesDb.close();nodesDb=undefined;
  const connected=new NativeLocalApprovalConnection(db,c);
  try{new AuditRepository(db,connected.providers.auditAnchors,connected.providers.auditKeys).initialize(checkpoint);initializeLocalApprovalRoots(db,connected.providers,c.scope);}finally{connected.close();}
 }finally{nodesDb?.close();native.close();}
}
export function initializeLocalApprovalRoots(db:Database.Database,providers:ApprovalTransactionProviders,scope:LocalApprovalNativeConfig["scope"]):void {
 const nodes=new ApprovalMetadataNodes(db),indexes=new ApprovalIndexBlobs(db,scope),writer=new ApprovalMetadataPlanWriter(db,scope);
 const transaction=new ApprovalTransaction(db,providers),auditScope={instance_id:scope.instance_id,tenant_id:scope.workspace_id};
 const event:Omit<AuditEvent,"occurred_at">={scope:auditScope,actor:{kind:"system",id:"mac_operator"},action:"approval_request",operation:"slack.post_thread_reply.v1",resource_id:"local_approval_roots",outcome:"succeeded",reason:"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1};
 transaction.runPrepared("local_roots_"+randomUUID().replaceAll("-",""),(_mark,state)=>{
  if(state.resource_bindings.some(r=>r.scope.instance_id===scope.instance_id&&r.scope.tenant_id===scope.workspace_id&&r.resource_id.startsWith("approval_")))throw Error("local_approval_roots_exist");
  const plan=nodes.read(n=>indexes.read(i=>{const plan=new ApprovalMetadataPlan(scope,emptyMetadataRoot({...scope,collection:"approval_records_v1"}),n,i);
   for(const record_kind of ["request","decision","consume","execution","notification","event","presentation"] as ApprovalRecordKind[])for(const membership of ["all","active"] as const){if(membership==="active"&&["decision","consume"].includes(record_kind))continue;plan.putIndex(null,{codec_version:1,scope,kind:"manifest",list:{record_kind,membership},count:0,head:null,tail:null});}return plan.finish();}));
  return {event,resource_commitments:[{scope:auditScope,resource_id:"approval_clock_marks",resource_digest:emptyMetadataRoot({...scope,collection:"approval_clock_marks_v1"})},
   {scope:auditScope,resource_id:"approval_payloads",resource_digest:emptyMetadataRoot({...scope,collection:"approval_payloads_v1"})},{scope:auditScope,resource_id:"approval_execution_markers",resource_digest:emptyMetadataRoot({...scope,collection:"approval_execution_markers_v1"})},
   {scope:auditScope,resource_id:"approval_records",resource_digest:plan.proposed_root}].sort((a,b)=>a.resource_id.localeCompare(b.resource_id)),mutation:()=>{writer.stage(plan);return null;}};
 });
}

function operator(c:LocalApprovalNativeConfig,operation:string,confirmation:string){
 if(process.platform!=="darwin"||!process.stdin.isTTY||process.getuid?.()!==process.geteuid?.()||confirmation!==`${c.scope.instance_id}/${c.scope.workspace_id}/${c.owner_id}:${operation}`)throw Error("local_approval_operator_confirmation_required");
}
function readNativeKey(native:NativeKeychainPort,c:LocalApprovalNativeConfig,purpose:z.infer<typeof keySchema>["purpose"],version:number){
 const r=parseKeychainCasResponse(native.exchange(encodeKeychainCasRequest(keyScope(c,purpose,version))));if(r.status!=="observed")return null;
 const value=keySchema.parse(JSON.parse(Buffer.from(r.value,"base64").toString("utf8")));if(value.purpose!==purpose||value.version!==version)throw Error("local_approval_key_unverified");return {value,revision:r.revision,bytes:Buffer.from(r.value,"base64")};
}
function operatorAudit(db:Database.Database,connection:NativeLocalApprovalConnection,id:string,at:string,operation:"credential.change.v1"|"policy.change.v1",resource:string,outcome:"succeeded"|"needs_review"="succeeded"){
 const c=connection.config,audit=new AuditRepository(db,connection.providers.auditAnchors,connection.providers.auditKeys);
 withSecurityTransactionLock(db,()=>{
  const existing=audit.readVerifiedState(()=>db.prepare("SELECT record_json FROM security_audit_records WHERE transaction_id=?").get(id)) as {record_json:string}|undefined;
  if(existing){const event=JSON.parse(existing.record_json).event;if(event.resource_id!==resource||event.operation!==operation||event.actor.id!==c.owner_id)throw Error("local_approval_maintenance_audit_conflict");return null;}
  audit.appendPrepared(id,c.key_version,()=>({event:{occurred_at:at,scope:{instance_id:c.scope.instance_id,tenant_id:c.scope.workspace_id},actor:{kind:"operator",id:c.owner_id},action:"policy_change",operation,resource_id:resource,outcome,reason:outcome==="needs_review"?"clock_anomaly":"none",session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},resource_digest:null,mutation:()=>null}));return null;
 });
}
/** 旧key/rootを破棄せず、DB外のactive-version CASを一世代だけ前進させる。
 * partial結果はphaseを保ち、同じexact操作の人手再開のみ許す。 */
export function rotateNativeLocalApproval(db:Database.Database,input:LocalApprovalNativeConfig,nextVersion:number,confirmation:string):LocalApprovalNativeConfig{
 const c=localApprovalNativeConfigSchema.parse(input);operator(c,`rotate:${nextVersion}`,confirmation);
 if(nextVersion!==c.key_version+1||!Number.isSafeInteger(nextVersion))throw Error("local_approval_rotation_version_invalid");
 const native=new NativeKeychainPort(),store=new LocalMaintenanceStore(new HeadPort(native,maintenanceScope(c)));
 try{
  const next={...c,key_version:nextVersion};
  rotateProtectedKeys(store,c.key_version,nextVersion,digest(c),{
   change:(expected,value)=>withSecurityTransactionLock(db,()=>store.change(expected,value)),
   stageNewKeys:()=>{
    const at=new NativeClockSource().observe().wall_utc;
    for(const purpose of keySchema.shape.purpose.options){let key=readNativeKey(native,c,purpose,nextVersion);
     if(!key){native.provision(keyScope(c,purpose,nextVersion),Buffer.from(JSON.stringify({codec_version:1,purpose,version:nextVersion,state:"active",activated_at:at,signing_expires_at:new Date(Date.parse(at)+89*86400000).toISOString(),secret_hex:randomBytes(32).toString("hex")})));key=readNativeKey(native,c,purpose,nextVersion);}
     if(!key||key.value.state!=="active"||key.value.activated_at>at||key.value.signing_expires_at<=at)throw Error("local_approval_rotation_key_unverified");
    }
   },
   auditAndInvalidate:operationId=>{
    const connection=new NativeLocalApprovalConnection(db,next,maintenanceAccess);
    try{const at=connection.providers.clock.observe().wall_utc;if(at<connection.providers.clockMarks.read().effective_utc)throw Error("local_approval_clock_unverified");
     operatorAudit(db,connection,operationId,at,"credential.change.v1",`key_version_${nextVersion}`);
     rebaseNativeForMaintenance(db,connection,store,operationId+"_boot");invalidateLocalApprovals(db,connection.providers,c.scope,c.owner_id);
    }finally{connection.close();}
   },
   retireOldKeys:()=>{
    for(const purpose of keySchema.shape.purpose.options){const old=readNativeKey(native,c,purpose,c.key_version);if(!old||old.value.state==="revoked")throw Error("local_approval_rotation_key_unverified");
     if(old.value.state==="active"){const bytes=Buffer.from(JSON.stringify({...old.value,state:"verification_only"})),result=parseKeychainCasResponse(native.exchange(encodeKeychainCasRequest(keyScope(c,purpose,c.key_version),{revision:old.revision,value:old.bytes},bytes)));
      if(result.status!=="changed"||result.revision!==old.revision+1||Buffer.from(result.value,"base64").compare(bytes)!==0)throw Error("local_approval_rotation_unknown");}
    }
   }
  });return next;
 }finally{native.close();}
}

function rebaseNativeForMaintenance(db:Database.Database,connection:NativeLocalApprovalConnection,store:LocalMaintenanceStore,transactionId:string):void {
 const source=connection.providers.clock.observe(),clock=connection.providers.clockMarks;
 if(!(clock instanceof ProtectedClockMarks))throw Error("local_approval_clock_provider_invalid");
 let current=store.read(),previous=clock.read(),planned=current.state.recovery_mark;
 if(previous.boot_id===source.boot_id){
  if(planned&&planned.boot_id!==source.boot_id)throw Error("local_approval_recovery_boot_changed");
  if(planned){if(Date.parse(previous.effective_utc)<Date.parse(planned.effective_utc))throw Error("local_approval_recovery_unverified");operatorAudit(db,connection,planned.transaction_id+"_audit",planned.effective_utc,"policy.change.v1","clock_boot_rebase");}
  return;
 }
 if(source.wall_utc<previous.effective_utc)throw Error("local_approval_clock_rollback");
 if(planned&&planned.boot_id!==source.boot_id){planned=null;transactionId=transactionId+"_"+randomUUID().slice(0,8);}
 if(!planned){planned={codec_version:1,transaction_id:transactionId,previous_transaction_id:previous.transaction_id,boot_id:source.boot_id,continuous_ms:source.continuous_ms,effective_utc:source.wall_utc};
  current=withSecurityTransactionLock(db,()=>store.change(current,{...current.state,recovery_mark:planned}));
 }
 if(planned.boot_id!==source.boot_id||planned.previous_transaction_id!==previous.transaction_id)throw Error("local_approval_recovery_unverified");
 withSecurityTransactionLock(db,()=>clock.rebaseForOperator(previous,planned!));
 operatorAudit(db,connection,planned.transaction_id+"_audit",planned.effective_utc,"policy.change.v1","clock_boot_rebase");
}
/** Mac再起動後の明示復旧。旧expiry/used-ID/rootは維持し、全旧未完了権限を破棄する。 */
export function recoverNativeLocalApproval(db:Database.Database,input:LocalApprovalNativeConfig,confirmation:string):void {
 const c=localApprovalNativeConfigSchema.parse(input);operator(c,"recover",confirmation);
 const native=new NativeKeychainPort(),store=new LocalMaintenanceStore(new HeadPort(native,maintenanceScope(c)));
 let connection:NativeLocalApprovalConnection|undefined;
 try{
  let current=store.read();if(current.state.active_key_version!==c.key_version)throw Error("local_approval_recovery_version_invalid");
  connection=new NativeLocalApprovalConnection(db,c,maintenanceAccess);
  new AuditRepository(db,connection.providers.auditAnchors,connection.providers.auditKeys).verify();
  const previous=connection.providers.clockMarks.read(),source=connection.providers.clock.observe();
  const auditKey=connection.providers.auditKeys(c.key_version);if(!auditKey||auditKey.state!=="active"||auditKey.signing_expires_at<=source.wall_utc)throw Error("local_approval_rotation_required");
  if(current.state.phase==="ready"){
   if(previous.boot_id===source.boot_id)throw Error("local_approval_recovery_not_required");
   if(source.wall_utc<previous.effective_utc)throw Error("local_approval_clock_rollback");
   const operationId="recover_"+randomUUID().replaceAll("-","");
   current=withSecurityTransactionLock(db,()=>store.change(current,{...current.state,phase:"boot_recovery",operation_id:operationId,next_key_version:null,operation_config_digest:digest(c),recovery_mark:{codec_version:1,transaction_id:operationId,previous_transaction_id:previous.transaction_id,boot_id:source.boot_id,continuous_ms:source.continuous_ms,effective_utc:source.wall_utc}}));
  }
  if(current.state.phase!=="boot_recovery"||current.state.operation_config_digest!==digest(c))throw Error("local_approval_maintenance_conflict");
  if(current.state.recovery_mark?.boot_id!==source.boot_id){
   if(source.wall_utc<previous.effective_utc)throw Error("local_approval_clock_rollback");
   const operationId="recover_"+randomUUID().replaceAll("-","");current=withSecurityTransactionLock(db,()=>store.change(current,{...current.state,operation_id:operationId,recovery_mark:{codec_version:1,transaction_id:operationId,previous_transaction_id:previous.transaction_id,boot_id:source.boot_id,continuous_ms:source.continuous_ms,effective_utc:source.wall_utc}}));
  }
  rebaseNativeForMaintenance(db,connection,store,current.state.operation_id!);
  invalidateLocalApprovals(db,connection.providers,c.scope,c.owner_id);
  operatorAudit(db,connection,current.state.operation_id!+"_complete",connection.providers.clockMarks.read().effective_utc,"policy.change.v1","clock_recovery_complete");
  const final=store.read();withSecurityTransactionLock(db,()=>store.change(final,{...final.state,phase:"ready",operation_id:null,operation_config_digest:null,recovery_mark:null}));
 }finally{connection?.close();native.close();}
}
