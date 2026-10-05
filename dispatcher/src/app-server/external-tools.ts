import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {RuntimeStore,AgentRecord} from "./store.js";
import type {RpcMessage} from "./rpc.js";
const resultSchema=z.strictObject({request_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),state:z.enum(["pending","succeeded","failed","cancelled","rejected","expired","execution_cancelled","consume_expired","delivery_failed","source_denied"])});
const args=z.strictObject({operation_slot:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),text:z.string().min(1).max(3000)});
export const externalReplyTool={type:"function",name:"dona_request_thread_reply",description:"現在のDona依頼元スレッドへ、このexact本文を一度だけ投稿する人間承認を要求する。宛先・依頼者はhostが固定する。承認・実行結果を待つ間は同じ投稿を別toolで送らない。",inputSchema:{type:"object",properties:{operation_slot:{type:"string",description:"同じ操作で再利用する安定した識別子"},text:{type:"string",maxLength:3000}},required:["operation_slot","text"],additionalProperties:false}};
export interface ExternalToolRequest {request_id:string;agent:string;generation:string;thread_id:string;turn_id:string;call_id:string;rpc_id_json:string;role:"main"|"worker";attempt_id:string|null;source_event_id:string|null;operation_slot:string;text:string;state:"pending"|"answering"|"resolved"|"expired";result_json:string|null;created_at:string}
/** Runtime専用の入力待ち。Codex approval/questionとは別のtyped callとする。 */
export class ExternalToolQueue {
 constructor(private readonly store:RuntimeStore){store.db.exec(`CREATE TABLE IF NOT EXISTS external_tool_requests(request_id TEXT PRIMARY KEY,agent TEXT NOT NULL,generation TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,rpc_id_json TEXT NOT NULL,role TEXT NOT NULL,attempt_id TEXT,source_event_id TEXT,operation_slot TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,UNIQUE(agent,generation,call_id));`);}
 expireRestart(){this.store.db.prepare("UPDATE external_tool_requests SET state='expired',text='' WHERE state IN ('pending','answering')").run();}
 accept(agent:AgentRecord,message:RpcMessage):ExternalToolRequest{
  const p=message.params as Record<string,unknown>;
  if(p.tool!==externalReplyTool.name||p.namespace!==null&&p.namespace!==undefined||typeof p.callId!=="string"||p.callId.length>128||!p.callId||p.threadId!==agent.thread_id||p.turnId!==agent.turn_id||message.id===undefined)throw Error("runtime_external_identity_invalid");
  const input=args.parse(p.arguments),config=JSON.parse(agent.config_json);
  if(agent.role==="worker"&&(typeof config.attemptId!=="string"||config.threadConfig?.config?.["features.default_mode_request_user_input"]===false))throw Error("runtime_external_scope_invalid");
  const prior=this.store.db.prepare("SELECT * FROM external_tool_requests WHERE agent=? AND generation=? AND call_id=?").get(agent.name,agent.generation,p.callId) as ExternalToolRequest|undefined;
  if(prior){if(prior.state!=="pending"||prior.thread_id!==agent.thread_id||prior.turn_id!==agent.turn_id||prior.operation_slot!==input.operation_slot||prior.text!==input.text)throw Error("runtime_external_conflict");return prior;}
  if((this.store.db.prepare("SELECT COUNT(*) n FROM external_tool_requests WHERE state='pending'").get() as {n:number}).n>=64)throw Error("runtime_external_limit");
  const row:ExternalToolRequest={request_id:"ext_"+randomUUID().replaceAll("-",""),agent:agent.name,generation:agent.generation,thread_id:agent.thread_id!,turn_id:agent.turn_id!,call_id:p.callId,rpc_id_json:JSON.stringify(message.id),role:agent.role,attempt_id:agent.role==="worker"?config.attemptId:null,source_event_id:null,...input,state:"pending",result_json:null,created_at:new Date().toISOString()};
  this.store.db.prepare("INSERT INTO external_tool_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(row.request_id,row.agent,row.generation,row.thread_id,row.turn_id,row.call_id,row.rpc_id_json,row.role,row.attempt_id,row.source_event_id,row.operation_slot,row.text,row.state,row.result_json,row.created_at);
  return row;
 }
 pending(agent?:string):ExternalToolRequest[]{return this.store.db.prepare("SELECT * FROM external_tool_requests WHERE state='pending' AND (? IS NULL OR agent=?) ORDER BY created_at,request_id LIMIT 64").all(agent??null,agent??null) as ExternalToolRequest[];}
 get(id:string):ExternalToolRequest|undefined{return this.store.db.prepare("SELECT * FROM external_tool_requests WHERE request_id=?").get(id) as ExternalToolRequest|undefined;}
 source(row:ExternalToolRequest):ExternalToolRequest{
  if(row.role!=="main")return row;
  const found=this.store.db.prepare("SELECT operation_key,result_json FROM operations WHERE agent=? AND state='accepted'").all(row.agent) as {operation_key:string;result_json:string}[];
  const matches=found.filter(r=>{const p=JSON.parse(r.result_json);return p.generation===row.generation&&p.threadId===row.thread_id&&p.turnId===row.turn_id;});
  if(matches.length!==1||!/^evt_[0-9A-HJKMNP-TV-Z]{26}$/i.test(matches[0]!.operation_key))throw Error("runtime_external_source_unavailable");
  return {...row,source_event_id:matches[0]!.operation_key};
 }
 resolved(agent:string,generation:string,rpcId:unknown){this.store.db.prepare("UPDATE external_tool_requests SET state='resolved' WHERE agent=? AND generation=? AND rpc_id_json=? AND state='answering'").run(agent,generation,JSON.stringify(rpcId));}
 waiting(agent:string){return !!this.store.db.prepare("SELECT 1 FROM external_tool_requests WHERE agent=? AND state IN ('pending','answering') LIMIT 1").get(agent);}
 resolve(id:string,result:{request_id:string|null;state:string}){const canonical=JSON.stringify(resultSchema.parse(result));const row=this.get(id);if(!row)throw Error("runtime_external_not_found");
  if(row.state==="resolved"||row.state==="answering"){if(row.result_json!==canonical)throw Error("runtime_external_conflict");return row;}
  if(row.state!=="pending")throw Error("runtime_external_expired");this.store.db.prepare("UPDATE external_tool_requests SET state='answering',text='',result_json=? WHERE request_id=? AND state='pending'").run(canonical,id);return this.get(id)!;
 }
}
