import {credentialShaped} from "../credential-shaped.js";
import {randomUUID,createHash} from "node:crypto";
import {z} from "zod";
import type {RuntimeStore,AgentRecord} from "./store.js";
import type {RpcMessage} from "./rpc.js";
import {workerReportSchema} from "../worker-messaging.js";
import {stableStringify} from "../validation.js";

const input=z.strictObject({report_key:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
 payload:workerReportSchema.shape.payload,correlation_message_id:workerReportSchema.shape.correlation_message_id,
 conversation_revision:workerReportSchema.shape.conversation_revision});
const acceptanceReceipt=z.strictObject({message_id:z.string().regex(/^msg_[0-9a-hjkmnp-tv-z]{26}$/),receipt_id:z.string().regex(/^rcpt_[0-9a-hjkmnp-tv-z]{26}$/),outcome:z.enum(["created","reused"])});
const rejectionReceipt=z.strictObject({state:z.literal("denied"),diagnostic:z.enum(["payload_rejected","report_rejected","attempt_unavailable"])});
const unknownReceipt=z.strictObject({state:z.literal("unknown"),diagnostic:z.literal("receipt_unavailable")});
const receipt=z.union([acceptanceReceipt,rejectionReceipt,unknownReceipt]);
export function reportResponseSucceeded(resultJson:string):boolean{const result=receipt.parse(JSON.parse(resultJson));return !("state" in result&&["denied","unknown"].includes(result.state));}

export const workerReportTool={type:"function",name:"dona_worker_report",description:"親Donaへcheckpoint、question、risk、decision_requestを送る。安定したreport_keyを同じ内容の照合に使う。command、path、URL、credential、生logを含めない。Job/Task/宛先はhostが固定する。",inputSchema:{type:"object",properties:{report_key:{type:"string",maxLength:128},payload:{oneOf:[{type:"object",properties:{kind:{const:"checkpoint"},summary:{type:"string",maxLength:4000}},required:["kind","summary"],additionalProperties:false},{type:"object",properties:{kind:{const:"question"},question:{type:"string",maxLength:4000}},required:["kind","question"],additionalProperties:false},{type:"object",properties:{kind:{const:"risk"},summary:{type:"string",maxLength:4000},severity:{enum:["low","medium","high"]}},required:["kind","summary","severity"],additionalProperties:false},{type:"object",properties:{kind:{const:"decision_request"},question:{type:"string",maxLength:4000},options:{type:"array",items:{type:"string",maxLength:1000},minItems:1,maxItems:8}},required:["kind","question","options"],additionalProperties:false}]},correlation_message_id:{type:"string"},conversation_revision:{type:"integer",minimum:0}},required:["report_key","payload"],additionalProperties:false}};
export const workerReportStatusTool={type:"function",name:"dona_worker_report_status",description:"同じworker/Attempt/runtimeのreport_keyをread-onlyで照合する。pending/expired/unknownを未実行と推測せず、報告や外部操作を自動再送しない。",inputSchema:{type:"object",properties:{report_key:{type:"string",minLength:1,maxLength:128}},required:["report_key"],additionalProperties:false}};
export interface RuntimeWorkerReport {request_id:string;agent:string;generation:string;thread_id:string;turn_id:string;call_id:string;rpc_id_json:string;attempt_id:string;report_key:string;request_sequence:number;payload_json:string;payload_sha256:string;created_at:string;state:"pending"|"answering"|"resolved"|"expired";result_json:string|null}
/** Runtime専用queue。callerのjob/role/宛先申告を受けず、現在のworker streamから固定する。 */
export class WorkerReportQueue {
 private availableUntil=0;private nextRetention=0;
 constructor(private readonly store:RuntimeStore){store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_worker_reports(request_id TEXT PRIMARY KEY,agent TEXT NOT NULL,generation TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,rpc_id_json TEXT NOT NULL,attempt_id TEXT NOT NULL,report_key TEXT NOT NULL,request_sequence INTEGER NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,UNIQUE(attempt_id,report_key),UNIQUE(attempt_id,request_sequence));`);}
 retirePayloads(at=new Date()){return this.store.db.prepare("UPDATE runtime_worker_reports SET payload_json='' WHERE state IN ('resolved','expired') AND created_at<? AND payload_json<>''").run(new Date(at.getTime()-30*86400000).toISOString()).changes;}
 availability(enabled:boolean){if(enabled&&Date.now()>=this.nextRetention){this.retirePayloads();this.nextRetention=Date.now()+60000;}this.availableUntil=enabled?Date.now()+30000:0;return {enabled,ttl_ms:enabled?30000:0};}
 expireRestart(){this.store.db.prepare("UPDATE runtime_worker_reports SET state='expired',payload_json='' WHERE state IN ('pending','answering')").run();}
 expireTurn(agent:string,generation:string,turn:string){this.store.db.prepare("UPDATE runtime_worker_reports SET state='expired',payload_json='' WHERE agent=? AND generation=? AND turn_id<>? AND state IN ('pending','answering')").run(agent,generation,turn);}
 expireAgent(agent:string,generation:string){this.store.db.prepare("UPDATE runtime_worker_reports SET state='expired',payload_json='' WHERE agent=? AND generation=? AND state IN ('pending','answering')").run(agent,generation);}
 accept(agent:AgentRecord,message:RpcMessage):RuntimeWorkerReport {
  const p=message.params as Record<string,unknown>,config=JSON.parse(agent.config_json);
  if(this.availableUntil<=Date.now()||agent.role!=="worker"||config.workerMessaging!==true||config.threadConfig?.config?.["features.default_mode_request_user_input"]===false||!/^job_[0-9a-hjkmnp-tv-z]{26}$/.test(config.attemptId??""))throw Error("runtime_worker_report_unavailable");
  if(p.tool!==workerReportTool.name||p.namespace!==null&&p.namespace!==undefined||typeof p.callId!=="string"||!p.callId||p.callId.length>128||p.threadId!==agent.thread_id||p.turnId!==agent.turn_id||message.id===undefined)throw Error("runtime_worker_report_identity_invalid");
  const value=input.parse(p.arguments),canonical=stableStringify(value),payloadHash=createHash("sha256").update(canonical).digest("hex"),wire=[value.report_key,...Object.values(value.payload).flatMap(v=>typeof v==="string"?[v]:Array.isArray(v)?v:[])].join("\n");
  if(credentialShaped.test(wire)||Buffer.byteLength(canonical)>16384||/(?:[/\\]|https?:\/\/|file:|\/Users\/|\/private\/|\/tmp\/|[A-Z]:\\|\bBearer\s|xox[baprs]-|github_pat_|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN[^\n]*PRIVATE KEY-----|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|stdout|stderr)\b|\$\(|`|\b(?:rm|curl|wget|bash|sh|eval|exec|npm|node|git|python|sudo|cp|mv|echo)\s)/i.test(wire))throw Error("runtime_worker_report_payload_denied");
  if([agent.name,agent.generation,agent.thread_id,agent.turn_id,agent.cwd,agent.release].some(v=>v&&canonical.includes(v)))throw Error("runtime_worker_report_payload_denied");
  return this.store.db.transaction(()=>{
   const prior=this.store.db.prepare("SELECT * FROM runtime_worker_reports WHERE attempt_id=? AND report_key=?").get(config.attemptId,value.report_key) as RuntimeWorkerReport|undefined;
   if(prior){if(prior.agent!==agent.name||prior.generation!==agent.generation||prior.thread_id!==agent.thread_id||prior.payload_sha256!==payloadHash||prior.state==="expired")throw Error("runtime_worker_report_conflict");if(prior.state==="pending"&&prior.call_id!==p.callId)throw Error("runtime_worker_report_already_pending");return prior;}
   if((this.store.db.prepare("SELECT COUNT(*) n FROM runtime_worker_reports WHERE state IN ('pending','answering')").get() as {n:number}).n>=64)throw Error("runtime_worker_report_limit");
   const sequence=(this.store.db.prepare("SELECT COALESCE(MAX(request_sequence),0) n FROM runtime_worker_reports WHERE attempt_id=?").get(config.attemptId) as {n:number}).n+1;
   if(sequence>256)throw Error("runtime_worker_report_limit");
   const row:RuntimeWorkerReport={request_id:randomUUID(),agent:agent.name,generation:agent.generation,thread_id:agent.thread_id!,turn_id:agent.turn_id!,call_id:p.callId as string,rpc_id_json:JSON.stringify(message.id),attempt_id:config.attemptId,report_key:value.report_key,request_sequence:sequence,payload_json:canonical,payload_sha256:payloadHash,created_at:new Date().toISOString(),state:"pending",result_json:null};
   this.store.db.prepare("INSERT INTO runtime_worker_reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(row.request_id,row.agent,row.generation,row.thread_id,row.turn_id,row.call_id,row.rpc_id_json,row.attempt_id,row.report_key,row.request_sequence,row.payload_json,row.payload_sha256,row.created_at,row.state,row.result_json);
   return row;
  }).immediate();
 }
 status(agent:AgentRecord,message:RpcMessage){
  const p=message.params as Record<string,unknown>,config=JSON.parse(agent.config_json);
  if(agent.role!=="worker"||config.workerMessaging!==true||config.threadConfig?.config?.["features.default_mode_request_user_input"]===false||p.tool!==workerReportStatusTool.name||p.namespace!==null&&p.namespace!==undefined||p.threadId!==agent.thread_id||p.turnId!==agent.turn_id)throw Error("runtime_worker_report_not_current");
  const value=z.strictObject({report_key:input.shape.report_key}).parse(p.arguments);
  const row=this.store.db.prepare("SELECT * FROM runtime_worker_reports WHERE attempt_id=? AND report_key=?").get(config.attemptId,value.report_key) as RuntimeWorkerReport|undefined;
  if(!row)return {state:"not_found"};
  if(row.agent!==agent.name||row.generation!==agent.generation||row.thread_id!==agent.thread_id)throw Error("runtime_worker_report_not_current");
  return {state:row.state,...(row.result_json?{receipt:JSON.parse(row.result_json)}:{})};
 }
 unavailablePending(){return this.availableUntil>Date.now()?[]:this.pending();}
 recoverable():RuntimeWorkerReport[]{return this.store.db.prepare("SELECT * FROM runtime_worker_reports WHERE state='pending' OR (state IN ('answering','resolved') AND json_extract(result_json,'$.state')='unknown' AND payload_json<>'') ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,CASE WHEN state<>'pending' THEN created_at ELSE '' END DESC,attempt_id,request_sequence LIMIT 64").all() as RuntimeWorkerReport[];}
 reconcileReceipt(id:string,result:unknown){const row=this.get(id),canonical=stableStringify(acceptanceReceipt.parse(result));if(!row||!row.result_json||JSON.parse(row.result_json).state!=="unknown")throw Error("runtime_worker_report_reconciliation_invalid");this.store.db.prepare("UPDATE runtime_worker_reports SET result_json=? WHERE request_id=? AND result_json=?").run(canonical,id,row.result_json);return this.get(id)!;}
 pending():RuntimeWorkerReport[]{return this.store.db.prepare("SELECT * FROM runtime_worker_reports WHERE state='pending' ORDER BY attempt_id,request_sequence LIMIT 64").all() as RuntimeWorkerReport[];}
 get(id:string){return this.store.db.prepare("SELECT * FROM runtime_worker_reports WHERE request_id=?").get(id) as RuntimeWorkerReport|undefined;}
 resolve(id:string,result:unknown){const canonical=stableStringify(receipt.parse(result)),row=this.get(id);if(!row)throw Error("runtime_worker_report_not_found");if(row.state==="answering"||row.state==="resolved"){if(row.result_json!==canonical)throw Error("runtime_worker_report_conflict");return row;}if(row.state!=="pending")throw Error("runtime_worker_report_expired");this.store.db.prepare("UPDATE runtime_worker_reports SET state='answering',result_json=? WHERE request_id=? AND state='pending'").run(canonical,id);return this.get(id)!;}
 resolved(agent:string,generation:string,rpcId:unknown){this.store.db.prepare("UPDATE runtime_worker_reports SET state='resolved' WHERE agent=? AND generation=? AND rpc_id_json=? AND state='answering'").run(agent,generation,JSON.stringify(rpcId));}
 waiting(agent:string){return !!this.store.db.prepare("SELECT 1 FROM runtime_worker_reports WHERE agent=? AND state IN ('pending','answering')").get(agent);}
}
