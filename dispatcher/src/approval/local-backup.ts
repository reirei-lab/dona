import fs from "node:fs";
import path from "node:path";
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import Database from "better-sqlite3";
import {z} from "zod";
import {AuditRepository} from "../audit/repository.js";
import {openSecurityReadOnlyDatabase,withSecurityTransactionLock} from "../audit/coordination.js";
import {verifyApprovalIntegrity} from "./schema.js";
import {ApprovalRecordRepository} from "./record-repository.js";
import {ApprovalPayloadRepository} from "./payload-repository.js";
import type {ApprovalTransactionProviders} from "./transaction.js";
import type {LocalApprovalNativeConfig} from "./local-native.js";
import {advanceClockMark} from "./clock.js";
import {stableStringify} from "../validation.js";
import {verifyLocalOperationsSchema,type LocalOperationsOperator} from "./local-operations.js";
// exact schema検証の後もexport対象は固定。Dispatcherイベント、Task本文、端末credentialは含めない。
const tables=["security_audit_schema","security_audit_checkpoint","security_audit_records","approval_schema","approval_clock_reservations","approval_requests","approval_decisions","approval_consumes","approval_execution_attempts","approval_notifications","approval_event_outbox","approval_presentation_updates","approval_metadata_nodes","approval_index_blobs","approval_payload_metadata","approval_payload_secrets","approval_execution_markers","local_approval_operation_evidence"] as const;
const manifestTable="local_approval_backup_manifest";
const manifestSchema=z.strictObject({codec_version:z.literal(1),purpose:z.literal("metadata_only_never_activate"),identity_digest:z.string().regex(/^[a-f0-9]{64}$/),snapshot_digest:z.string().regex(/^[a-f0-9]{64}$/),anchor:z.unknown(),clock:z.unknown(),key_version:z.number().int().positive()});
const sha=(v:unknown)=>createHash("sha256").update(stableStringify(v)).digest("hex");
const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function privateDirectory(file:string){if(!path.isAbsolute(file)||path.normalize(file)!==file)throw Error();for(let dir=path.dirname(file);;dir=path.dirname(dir)){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid?.()].includes(s.uid)||(s.mode&0o022)!==0||dir===path.dirname(file)&&(s.uid!==process.getuid?.()||(s.mode&0o077)!==0))throw Error();if(dir===path.dirname(dir))break;}}
function noSidecars(file:string){for(const suffix of ["-wal","-shm","-journal"])if(fs.existsSync(file+suffix))throw Error();}
/** metadata専用artifact。live DB、保護head、key、used-nodeを上書きしない。 */
export class LocalApprovalBackup {
 constructor(private readonly db:Database.Database,private readonly providers:ApprovalTransactionProviders,private readonly config:LocalApprovalNativeConfig,private readonly operator:LocalOperationsOperator){}
 private checked(){if(!this.operator.authorize())throw Error("local_backup_unauthorized");}
 private identity(){return sha(this.config);}
 private mac(value:unknown,version:number){const key=this.providers.auditKeys(version);if(!key||!["active","verification_only"].includes(key.state))throw Error();return createHmac("sha256",key.secret).update("dona.local-approval.metadata-backup.v1\0").update(stableStringify(value)).digest("hex");}
 private snapshotDigest(db:Database.Database){const hash=createHash("sha256");let count=0,total=0;
  for(const name of tables){const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").pluck().get(name);if(typeof schema!=="string")throw Error();hash.update(stableStringify([name,schema]));if(name==="approval_payload_secrets")continue;
   for(const row of db.prepare(`SELECT * FROM ${q(name)} ORDER BY rowid`).iterate()){const wire=stableStringify(row);total+=Buffer.byteLength(wire);if(++count>100000||Buffer.byteLength(wire)>2097152||total>268435456)throw Error();hash.update(wire);}}
  return hash.digest("hex");
 }
 private inspect(db:Database.Database,allowMissingPayload:boolean){verifyApprovalIntegrity(db);verifyLocalOperationsSchema(db);const audit=new AuditRepository(db,this.providers.auditAnchors,this.providers.auditKeys),records=new ApprovalRecordRepository(db,this.providers.auditAnchors,this.providers.auditKeys,this.config.scope),payloads=new ApprovalPayloadRepository(db,this.providers.auditAnchors,this.providers.auditKeys,this.config.scope);
  return audit.readVerifiedState(state=>{this.checked();if(state.resource_bindings.some(b=>b.scope.instance_id!==this.config.scope.instance_id||b.scope.tenant_id!==this.config.scope.workspace_id))throw Error();
   if(db.prepare("SELECT 1 FROM security_audit_records WHERE json_extract(record_json,'$.event.scope.instance_id') IS NOT ? OR json_extract(record_json,'$.event.scope.tenant_id') IS NOT ? LIMIT 1").get(this.config.scope.instance_id,this.config.scope.workspace_id))throw Error();
   const recordTables={request:"approval_requests",decision:"approval_decisions",consume:"approval_consumes",execution:"approval_execution_attempts",notification:"approval_notifications",event:"approval_event_outbox",presentation:"approval_presentation_updates"};
   let omitted=0,payloadCount=0;

   for(const kind of ["request","decision","consume","execution","notification","event","presentation"] as const){let after:string|null=null,complete=false;
    for(let i=0;i<1000;i++){const page=records.readListPageInState(state,{record_kind:kind,membership:"all"},after,100);if(i===0&&db.prepare(`SELECT COUNT(*) FROM ${q(recordTables[kind])}`).pluck().get()!==page.count)throw Error();for(const r of page.records){if(r.kind==="request"||r.kind==="execution"){const p=payloads.inspectInState(state,r.kind==="request"?"request":"attempt",r.kind==="request"?r.row.request_id:r.row.attempt_id);if(p)payloadCount++;if(p?.metadata.state==="active"){omitted++;if(!allowMissingPayload&&p.secret.status!=="present")throw Error();}}}
     if(!page.has_more){complete=true;break;}after=page.next_after;}if(!complete)throw Error();}
   if(db.prepare("SELECT COUNT(*) FROM approval_payload_metadata").pluck().get()!==payloadCount)throw Error();
   for(const row of db.prepare("SELECT evidence_id,proof_json FROM local_approval_operation_evidence").iterate() as Iterable<{evidence_id:string;proof_json:string}>){
    const proof=JSON.parse(row.proof_json);if(stableStringify(proof.scope)!==stableStringify(this.config.scope))throw Error();
    const evidence=db.prepare("SELECT record_json FROM security_audit_records WHERE json_extract(record_json,'$.event.resource_id')=? AND json_extract(record_json,'$.event.session_ref')=?").get(row.evidence_id,"proof_"+sha(proof));if(!evidence)throw Error();
   }
   return {anchor:state.anchor,omitted_payloads:omitted};});
 }
 preview(destination:string){this.checked();privateDirectory(destination);if(fs.existsSync(destination)||destination===this.db.name)throw Error("local_backup_destination_exists");
  const anchor=new AuditRepository(this.db,this.providers.auditAnchors,this.providers.auditKeys).verify();return {safe_ready:false,metadata_only:true,confirmation:sha([this.identity(),destination,anchor,this.providers.clockMarks.read()])};}
 backup(destination:string,confirmation:string){let temporary:string|undefined,output:Database.Database|undefined;
  try{return withSecurityTransactionLock(this.db,()=>{this.checked();if(this.preview(destination).confirmation!==confirmation)throw Error();this.inspect(this.db,false);
   const audit=new AuditRepository(this.db,this.providers.auditAnchors,this.providers.auditKeys);
   temporary=path.join(path.dirname(destination),".approval-metadata-"+randomUUID());fs.closeSync(fs.openSync(temporary,"wx",0o600));output=new Database(temporary,{fileMustExist:true});output.pragma("journal_mode=DELETE");output.pragma("synchronous=FULL");output.pragma("cache_size=-2048");
   audit.readVerifiedState(state=>{this.checked();const before=this.providers.clockMarks.read();advanceClockMark(before,this.providers.clock.observe(),"backup_check",this.providers.maximumClockDriftMs);
    output!.transaction(()=>{const schemas=this.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all() as {type:string;name:string;tbl_name:string;sql:string}[];
     for(const name of tables){const table=schemas.find(s=>s.type==="table"&&s.name===name);if(!table)throw Error();output!.exec(table.sql);}
     let copiedRows=0,copiedBytes=0;for(const name of tables){if(name==="approval_payload_secrets")continue;const columns=this.db.prepare(`SELECT * FROM ${q(name)} LIMIT 0`).columns().map(c=>c.name),insert=output!.prepare(`INSERT INTO ${q(name)}(${columns.map(q).join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);
      for(const row of this.db.prepare(`SELECT * FROM ${q(name)} ORDER BY rowid`).iterate() as Iterable<Record<string,unknown>>){const bytes=Buffer.byteLength(stableStringify(row));copiedBytes+=bytes;if(++copiedRows>100000||bytes>2097152||copiedBytes>268435456)throw Error();insert.run(...columns.map(c=>row[c]));}}
     for(const item of schemas)if(["index","trigger"].includes(item.type)&&tables.includes(item.tbl_name as any))output!.exec(item.sql);
     output!.pragma(`application_id=${this.db.pragma("application_id",{simple:true})}`);
     const manifest={codec_version:1,purpose:"metadata_only_never_activate",identity_digest:this.identity(),snapshot_digest:this.snapshotDigest(output!),anchor:state.anchor,clock:before,key_version:this.config.key_version};
     output!.exec(`CREATE TABLE ${manifestTable}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),manifest_json TEXT NOT NULL,mac TEXT NOT NULL)`);output!.prepare(`INSERT INTO ${manifestTable} VALUES(1,?,?)`).run(stableStringify(manifest),this.mac(manifest,this.config.key_version));
    }).immediate();if(stableStringify(before)!==stableStringify(this.providers.clockMarks.read()))throw Error();return null;});
   output.close();output=undefined;const result=this.check(temporary!);if(result.status!=="continuity_verified")throw Error();this.publish(temporary!,destination);temporary=undefined;return {status:"backed_up",safe_ready:false,metadata_only:true,omitted_payloads:result.omitted_payloads};});
  }catch{throw Error("local_approval_backup_unverified");}finally{output?.close();if(temporary)fs.rmSync(temporary,{force:true});}}
 check(candidate:string){let db:Database.Database|undefined;try{this.checked();privateDirectory(candidate);noSidecars(candidate);if(candidate===this.db.name)throw Error();db=openSecurityReadOnlyDatabase(candidate);
  const found=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];if(found.length!==tables.length+1||found.some(r=>r.name!==manifestTable&&!tables.includes(r.name as any)))throw Error();
  const row=db.prepare(`SELECT manifest_json,mac FROM ${manifestTable} WHERE singleton=1`).get() as {manifest_json:string;mac:string}|undefined;if(!row)throw Error();const manifest=manifestSchema.parse(JSON.parse(row.manifest_json)),mac=this.mac(manifest,manifest.key_version);if(!/^[a-f0-9]{64}$/.test(row.mac)||!timingSafeEqual(Buffer.from(mac,"hex"),Buffer.from(row.mac,"hex")))throw Error();
  if(manifest.identity_digest!==this.identity()||manifest.key_version!==this.config.key_version||manifest.snapshot_digest!==this.snapshotDigest(db)||db.prepare("SELECT 1 FROM approval_payload_secrets LIMIT 1").get())throw Error();
  const inspected=this.inspect(db,true),clock=this.providers.clockMarks.read();if(stableStringify(inspected.anchor)!==stableStringify(manifest.anchor)||stableStringify(clock)!==stableStringify(manifest.clock))throw Error();advanceClockMark(clock,this.providers.clock.observe(),"restore_check",this.providers.maximumClockDriftMs);
  return {status:"continuity_verified" as const,safe_ready:false,metadata_only:true,omitted_payloads:inspected.omitted_payloads};
 }catch{return {status:"needs_review" as const,safe_ready:false,metadata_only:true};}finally{db?.close();}}
 restore(candidate:string,destination:string,confirmation:string){this.checked();privateDirectory(destination);if(fs.existsSync(destination)||destination===this.db.name||candidate===destination)throw Error("local_backup_destination_exists");
  const current=this.restorePreview(candidate,destination);if(current.status!=="continuity_verified"||current.confirmation!==confirmation)throw Error("local_backup_confirmation_stale");
  // 未検証fileのraw copyはしない。candidateの署名済みcurrent anchor/clockをexact gateとし、
  // 同じlive metadata snapshotだけを既存allowlist exporterで新しいDBへ再構成する。
  const reader=openSecurityReadOnlyDatabase(candidate);let expected:string;
  try{const row=reader.prepare(`SELECT manifest_json,mac FROM ${manifestTable} WHERE singleton=1`).get() as {manifest_json:string;mac:string};const manifest=manifestSchema.parse(JSON.parse(row.manifest_json));if(this.mac(manifest,manifest.key_version)!==row.mac||manifest.identity_digest!==this.identity())throw Error("local_backup_unverified");expected=sha([this.identity(),destination,manifest.anchor,manifest.clock]);}finally{reader.close();}
  const result=this.backup(destination,expected);return {...result,status:"restored_metadata_only",safe_ready:false,metadata_only:true};
 }

 restorePreview(candidate:string,destination:string){this.checked();privateDirectory(destination);const result=this.check(candidate);return {...result,confirmation:sha([this.identity(),candidate,destination,result,this.providers.auditAnchors.read(),this.providers.clockMarks.read()])};}
 private publish(temporary:string,destination:string){const fd=fs.openSync(temporary,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.linkSync(temporary,destination);fs.unlinkSync(temporary);const parent=fs.openSync(path.dirname(destination),"r");try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
}
