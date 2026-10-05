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
const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const headScope=(c:LocalApprovalNativeConfig,purpose:"clock_mark"|"audit_anchor")=>({instance_id:c.scope.instance_id,ledger_id:c.ledger_id,purpose});
const casScope=(c:LocalApprovalNativeConfig,purpose:"clock_mark"|"audit_anchor"):KeychainCasScope=>({access_group:c.access_group,instance_id:"head_"+digest(headScope(c,purpose)),purpose});
const keyScope=(c:LocalApprovalNativeConfig,purpose:string,version:number):KeychainCasScope=>({access_group:c.access_group,instance_id:"key_"+digest(["local_operator_v1",c.scope,purpose,version]),purpose:"approval_key"});
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
 readonly config:LocalApprovalNativeConfig;readonly providers:ApprovalTransactionProviders;readonly keys:ExternalApprovalKeys;
 private readonly native:NativeKeychainPort;private readonly nodesDb:Database.Database;
 constructor(readonly db:Database.Database,input:LocalApprovalNativeConfig){
  this.config=localApprovalNativeConfigSchema.parse(input);const opened:{close():void}[]=[];
  try{
   this.native=new NativeKeychainPort();opened.push(this.native);
   this.nodesDb=openSecurityDatabase(this.config.used_nodes_database);opened.push(this.nodesDb);this.nodesDb.pragma("synchronous=FULL");
   const main=fs.statSync(db.name),aux=fs.statSync(this.config.used_nodes_database);if(main.dev===aux.dev&&main.ino===aux.ino)throw Error();
   const nodes=new SqliteUsedTransactionNodes(this.nodesDb),c=this.config;
   const read=(purpose:z.infer<typeof keySchema>["purpose"],version:number)=>{
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
   for(const key of [this.keys.content(null),this.keys.wrapping(),this.keys.notification(),this.keys.execution(null)])if(key.state!=="active"||key.signing_expires_at<=observation.wall_utc)throw Error();return {ready:true as const,instance_id:this.config.scope.instance_id,workspace_id:this.config.scope.workspace_id};
  }catch{return {ready:false as const,reason:"protected_state_unverified"};}}
 close(){this.nodesDb.close();this.native.close();}
}

/** 人がMacのTTY上でexact instance/workspace/ownerを確認した初回のみ。
 * 部分失敗は停止し、同じscopeの再初期化・自動修復・旧root再生成はしない。 */
export function provisionNativeLocalApproval(db:Database.Database,input:LocalApprovalNativeConfig,confirmation:string):void {
 const c=localApprovalNativeConfigSchema.parse(input);
 if(process.platform!=="darwin"||!process.stdin.isTTY||process.getuid?.()!==process.geteuid?.()||confirmation!==`${c.scope.instance_id}/${c.scope.workspace_id}/${c.owner_id}`)throw Error("local_approval_operator_confirmation_required");
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_audit_checkpoint'").get()||fs.existsSync(c.used_nodes_database))throw Error("local_approval_already_provisioned");
 const native=new NativeKeychainPort(),clock=new NativeClockSource(),observation=clock.observe();let nodesDb:Database.Database|undefined;
 try{
  const fd=fs.openSync(c.used_nodes_database,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.closeSync(fd);
  nodesDb=openSecurityDatabase(c.used_nodes_database);nodesDb.pragma("synchronous=FULL");installUsedTransactionNodeSchema(nodesDb);const nodes=new SqliteUsedTransactionNodes(nodesDb);
  const keys=new Map<string,z.infer<typeof keySchema>>();
  for(const purpose of keySchema.shape.purpose.options){const key={codec_version:1 as const,purpose,version:c.key_version,state:"active" as const,activated_at:observation.wall_utc,
    signing_expires_at:new Date(Date.parse(observation.wall_utc)+89*86400000).toISOString(),secret_hex:randomBytes(32).toString("hex")};keys.set(purpose,key);native.provision(keyScope(c,purpose,c.key_version),Buffer.from(JSON.stringify(key)));}
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
