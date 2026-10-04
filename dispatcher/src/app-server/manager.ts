import { createHash,randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppServerRpc,type RpcMessage,RpcFailure } from "./rpc.js";
import {stableStringify} from "../validation.js";
import { RuntimeStore,type AgentRecord,type QuestionRecord } from "./store.js";
import { identity,processes,same,stopScope,type ProcessIdentity } from "./process.js";

export const hash=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
export interface StartAgent {name:string;role:"main"|"worker";cwd:string;release:string;args:string[];threadConfig:Record<string,unknown>}
export type RpcFactory=(args:string[],cwd:string)=>AppServerRpc;
const object=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};

export class AppServerManager {
  private connections=new Map<string,AppServerRpc>();
  private resets=new Map<string,string>();
  private queues=new Map<string,Promise<unknown>>();
  private recoveryAfter=new Map<string,number>();
  constructor(readonly store:RuntimeStore,private readonly factory:RpcFactory) {
    store.db.exec("CREATE TABLE IF NOT EXISTS main_recoveries(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,input_json TEXT NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS recovery_hints(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,reason TEXT NOT NULL,retry_after TEXT)");
    store.db.exec("CREATE TABLE IF NOT EXISTS stops(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,processes_json TEXT NOT NULL,state TEXT NOT NULL)");
    // 再接続していないprocessをidleとみなさない。永続receiptは残す。
    store.db.prepare("UPDATE questions SET state='expired' WHERE state IN ('pending','answering')").run();
    store.db.prepare("UPDATE agents SET state='unknown',sequence=sequence+1 WHERE state<>'stopped'").run();
  }
  serialized<T>(name:string,action:()=>Promise<T>):Promise<T> {
    const previous=this.queues.get(name)??Promise.resolve();const next=previous.catch(()=>{}).then(action);
    this.queues.set(name,next);void next.finally(()=>{if(this.queues.get(name)===next)this.queues.delete(name);}).catch(()=>{});return next;
  }
  async start(input:StartAgent):Promise<AgentRecord> {
    return this.serialized(input.name,()=>this.startAgent(input));
  }
  private async startAgent(input:StartAgent):Promise<AgentRecord> {
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(input.name)||!path.isAbsolute(input.cwd)||!path.isAbsolute(input.release)||!fs.statSync(input.cwd).isDirectory())throw Error("runtime_start_scope");
      const requestHash=hash(input),prior=this.store.agent(input.name);
      if(prior&&prior.state!=="stopped") {
        if(prior.request_hash!==requestHash)throw Error("runtime_agent_conflict");
        if(!this.connections.get(input.name)?.connected||!prior.thread_id||!["idle","working","waiting","interrupted"].includes(prior.state))throw Error("runtime_agent_recovery_required");
        return prior;
      }
      const row:AgentRecord={name:input.name,generation:randomUUID(),role:input.role,cwd:input.cwd,release:input.release,
        thread_id:input.role==="worker"?(prior?.thread_id??null):null,turn_id:null,pid:null,process_start:null,state:"starting",request_hash:requestHash,config_json:JSON.stringify(input),sequence:0};
      this.store.put(row);
      const rpc=this.factory(input.args,input.cwd);this.connections.set(input.name,rpc);
      // spawn直後のPIDを他のawaitより前に保存する。開始identityが取得できなければ準備は未確定。
      const pid=rpc.child.pid;if(!pid)throw Error("runtime_spawn_failed");
      const processIdentity=identity(pid);if(!processIdentity)throw Error("runtime_process_identity_missing");
      row.pid=pid;row.process_start=processIdentity.start;this.store.put(row);
      rpc.on("request",(message:RpcMessage)=>this.onRequest(row,message));
      rpc.on("notification",(message:RpcMessage)=>this.onNotification(row,message));
      rpc.on("disconnect",()=>{
        if(!this.store.db.open||this.store.agent(row.name)?.generation!==row.generation)return;
        this.store.db.prepare("UPDATE questions SET state='expired' WHERE agent=? AND generation=? AND state IN ('pending','answering')").run(row.name,row.generation);
        if(this.store.agent(row.name)?.state!=="stopped")this.store.change(row.name,row.generation,{state:"unknown"});
      });
      try {
        await rpc.initialize();
        const params={...input.threadConfig,cwd:input.cwd,...(row.thread_id?{threadId:row.thread_id,excludeTurns:true}:{})};
        const result=object(await rpc.request(row.thread_id?"thread/resume":"thread/start",params,90_000));
        const thread=object(result.thread);if(typeof thread.id!=="string")throw Error("runtime_thread_identity_missing");
        this.store.change(row.name,row.generation,{thread_id:thread.id,state:"idle"});
        return this.store.agent(row.name)!;
      } catch(error){this.store.change(row.name,row.generation,{state:"unknown"});throw error;}
  }
  status(name:string):AgentRecord|undefined {
    const row=this.store.agent(name);if(!row)return;
    const hint=this.store.db.prepare("SELECT reason,retry_after FROM recovery_hints WHERE agent=? AND generation=?").get(name,row.generation) as {reason:"capacity_wait"|"authorization_required"|"configuration_error";retry_after:string|null}|undefined;
    if(hint)row.recovery_hint={reason:hint.reason,...(hint.retry_after?{retry_after:hint.retry_after}:{})};
    if(row.state==="stopped") {
      const stop=this.store.db.prepare("SELECT processes_json FROM stops WHERE agent=? AND generation=? AND state='stopped'").get(name,row.generation) as {processes_json:string}|undefined;
      if(!stop)return {...row,state:"unknown"};
      const sample=processes();
      if((JSON.parse(stop.processes_json) as ProcessIdentity[]).some(p=>{const live=sample.find(x=>x.pid===p.pid);return same(p,live)&&!live!.state.includes("Z");}))return {...row,state:"unknown"};
    }
    if(row.state!=="stopped"&&(!this.connections.get(name)?.connected||!row.pid||identity(row.pid)?.start!==row.process_start))return {...row,state:"unknown"};
    return row;
  }
  private onRequest(agent:AgentRecord,message:RpcMessage):void {
    if(!this.store.db.open)return;
    const current=this.store.agent(agent.name);if(current?.generation!==agent.generation||message.id===undefined)return;
    const p=object(message.params),threadId=p.threadId,turnId=p.turnId;
    // MCP認証情報や任意schemaの入力をSlackへ転送しない。未対応のelicitationは
    // 明示cancelを返し、モデルに通常のエラー処理を続けさせる。
    if(message.method==="mcpServer/elicitation/request") {
      if(threadId===current.thread_id)this.connections.get(agent.name)?.respond(message.id,{action:"cancel",content:null,_meta:null});
      else this.connections.get(agent.name)?.reject(message.id,"Request identity is not current");
      return;
    }
    if(typeof threadId!=="string"||threadId!==current.thread_id||typeof turnId!=="string"||turnId!==current.turn_id) {
      this.connections.get(agent.name)?.reject(message.id,"Request identity is not current");return;
    }
    const kind=message.method==="item/tool/requestUserInput"?"question":message.method?.includes("requestApproval")?"approval":message.method==="mcpServer/elicitation/request"?"elicitation":undefined;
    if(!kind){this.connections.get(agent.name)?.reject(message.id);return;}
    if(agent.role==="main") {
      this.connections.get(agent.name)?.reject(message.id,"Dona main must ask the user through the configured Slack tools, publish its event Result, and handle the reply as a new event.");return;
    }
    const settings=object(object(JSON.parse(current.config_json)).threadConfig);
    if(kind==="question"&&object(settings.config)["features.default_mode_request_user_input"]===false) {
      this.connections.get(agent.name)?.reject(message.id,"This job has no interactive question channel. Continue within the authorized scope or publish a blocked Result explaining the missing input.");return;
    }
    if(kind==="question"&&Array.isArray(p.questions)&&p.questions.some(q=>object(q).isSecret===true)) {
      this.connections.get(agent.name)?.reject(message.id,"Secrets cannot be requested through Dona. Ask the parent to arrange local authentication without transmitting credentials.");return;
    }
    if(Buffer.byteLength(JSON.stringify(p))>65_536){this.connections.get(agent.name)?.reject(message.id,"Request too large");return;}
    const row:QuestionRecord={question_id:randomUUID(),agent:agent.name,generation:agent.generation,thread_id:threadId,turn_id:turnId,rpc_id_json:JSON.stringify(message.id),kind,
      payload_json:JSON.stringify({method:message.method,...p}),state:"pending",answer_hash:null,created_at:new Date().toISOString()};
    this.store.addQuestion(row);this.store.change(agent.name,agent.generation,{state:"waiting"});
  }
  private onNotification(agent:AgentRecord,message:RpcMessage):void {
    if(!this.store.db.open)return;
    const row=this.store.agent(agent.name);if(row?.generation!==agent.generation)return;
    const p=object(message.params);
    if(message.method==="account/rateLimits/updated") {
      const pending:unknown[]=[p],times:number[]=[];
      for(let i=0;pending.length&&i<128;i++) {
        const value=object(pending.shift());
        if(typeof value.usedPercent==="number"&&value.usedPercent>=100&&typeof value.resetsAt==="number"&&value.resetsAt*1000>Date.now()&&value.resetsAt*1000<Date.now()+366*86400_000)times.push(value.resetsAt*1000);
        pending.push(...Object.values(value).filter(v=>v&&typeof v==="object"));
      }
      if(times.length)this.resets.set(agent.name,new Date(Math.max(...times)).toISOString());
      return;
    }
    if(p.threadId!==row.thread_id)return;
    if(message.method==="turn/started") {
      const turn=object(p.turn);if(typeof turn.id==="string")this.store.change(agent.name,agent.generation,{turn_id:turn.id,state:"working"});
    } else if(message.method==="turn/completed") {
      const turn=object(p.turn);if(turn.id!==row.turn_id)return;
      const code=object(turn.error).codexErrorInfo;
      const reason=["usageLimitExceeded","rateLimitExceeded","flexUnavailable","serverOverloaded"].includes(String(code))?"capacity_wait":code==="unauthorized"?"authorization_required":["badRequest","sandboxError","cyberPolicy","misalignmentPolicyViolation","tooManyDenials"].includes(String(code))?"configuration_error":undefined;
      if(reason)this.store.db.prepare("INSERT INTO recovery_hints VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,reason=excluded.reason,retry_after=excluded.retry_after").run(agent.name,agent.generation,reason,reason==="capacity_wait"?(this.resets.get(agent.name)??new Date(Date.now()+900_000).toISOString()):null);
      // 非同期質問はturnが完了しても未解決であり得る。serverRequest/resolvedを終端証拠にする。
      this.store.change(agent.name,agent.generation,{turn_id:null,state:this.store.questions(agent.name).length?"waiting":turn.status==="completed"?"idle":"interrupted"});
    } else if(message.method==="serverRequest/resolved") {
      this.store.db.prepare("UPDATE questions SET state=CASE WHEN state='answering' THEN 'resolved' ELSE 'expired' END WHERE agent=? AND generation=? AND rpc_id_json=? AND state IN ('pending','answering')")
        .run(agent.name,agent.generation,JSON.stringify(p.requestId));
      if(this.store.questions(agent.name).length===0)this.store.change(agent.name,agent.generation,{state:row.turn_id?"working":"idle"});
    }
  }
  async prompt(name:string,key:string,text:string):Promise<unknown> {
    return this.serialized(name,async()=>{
      const row=this.status(name),rpc=this.connections.get(name);
      const requestHash=hash({text});
      const old=this.store.db.prepare("SELECT * FROM operations WHERE agent=? AND operation_key=?").get(name,key) as {request_hash:string;state:string;result_json:string|null}|undefined;
      if(old){if(old.request_hash!==requestHash)throw Error("runtime_operation_conflict");if(old.state!=="accepted")throw Error("runtime_acceptance_unknown");const accepted=JSON.parse(old.result_json!);if(accepted.generation!==row?.generation||accepted.threadId!==row?.thread_id)throw Error("runtime_operation_generation_changed");return {turnId:accepted.turnId};}
      if(!row||!rpc?.connected||!row.thread_id||!["idle","working","interrupted"].includes(row.state))throw new RpcFailure("runtime_not_ready","not_sent");
      this.store.db.prepare("DELETE FROM recovery_hints WHERE agent=? AND generation=?").run(name,row.generation);
      this.store.db.prepare("INSERT INTO operations VALUES(?,?,?,'sending',NULL)").run(name,key,requestHash);
      try {
        const params={threadId:row.thread_id,input:[{type:"text",text}],...(row.turn_id?{expectedTurnId:row.turn_id}:{clientUserMessageId:key})};
        const result=object(await rpc.request(row.turn_id?"turn/steer":"turn/start",params));
        const turnId=row.turn_id?result.turnId:object(result.turn).id;
        if(typeof turnId!=="string")throw Error("runtime_turn_identity_missing");
        this.store.db.prepare("UPDATE operations SET state='accepted',result_json=? WHERE agent=? AND operation_key=?").run(JSON.stringify({turnId,generation:row.generation,threadId:row.thread_id}),name,key);
        // notificationが先に完了を知らせた場合、そのstateを古いresponseで戻さない。
        const fresh=this.store.agent(name)!;
        if(fresh.sequence===row.sequence)this.store.change(name,row.generation,{turn_id:turnId,state:"working"});
        return {turnId};
      } catch(error) {
        this.store.db.prepare("UPDATE operations SET state=? WHERE agent=? AND operation_key=?").run(error instanceof RpcFailure&&error.acceptance==="rejected"?"rejected":"unknown",name,key);
        throw error;
      }
    });
  }
  async answer(name:string,id:string,answers:Record<string,{answers:string[]}>):Promise<QuestionRecord> {
    return this.serialized(name,async()=>{
      const q=this.store.question(id),row=this.status(name),rpc=this.connections.get(name),answerHash=hash(answers);
      if(!q||q.agent!==name||q.kind!=="question")throw Error("runtime_question_not_found");
      if(q.answer_hash===answerHash&&["answering","resolved"].includes(q.state))return q;
      if(q.state!=="pending"||!row||row.generation!==q.generation||row.thread_id!==q.thread_id||!rpc?.connected)throw Error("runtime_question_not_current");
      const questions=object(JSON.parse(q.payload_json)).questions;
      if(!Array.isArray(questions)||questions.some(x=>object(x).isSecret===true))throw Error("runtime_secret_question_requires_operator");
      const ids=questions.map(x=>object(x).id);
      if(Object.keys(answers).length!==ids.length||ids.some(id=>typeof id!=="string"||!answers[id]||!Array.isArray(answers[id]!.answers)||answers[id]!.answers.length===0||answers[id]!.answers.some(a=>typeof a!=="string"||a.length>16_384)))throw Error("runtime_answer_invalid");
      this.store.db.prepare("UPDATE questions SET state='answering',answer_hash=? WHERE question_id=? AND state='pending'").run(answerHash,id);
      rpc.respond(JSON.parse(q.rpc_id_json),{answers});
      return this.store.question(id)!;
    });
  }
  async approve(name:string,id:string,accepted:boolean):Promise<QuestionRecord> {
    return this.serialized(name,async()=>{
      const q=this.store.question(id),row=this.status(name),rpc=this.connections.get(name),digest=hash({accepted});
      if(!q||q.agent!==name||q.kind!=="approval")throw Error("runtime_approval_not_found");
      if(q.answer_hash===digest&&["answering","resolved"].includes(q.state))return q;
      if(q.state!=="pending"||!row||row.generation!==q.generation||row.thread_id!==q.thread_id||!rpc?.connected)throw Error("runtime_approval_not_current");
      const payload=object(JSON.parse(q.payload_json));let response:unknown;
      if(["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(String(payload.method)))response={decision:accepted?"accept":"decline"};
      else if(payload.method==="item/permissions/requestApproval")response={permissions:accepted?Object.fromEntries(Object.entries(object(payload.permissions)).filter(([,value])=>value!==null)):{},scope:"turn"};
      else throw Error("runtime_approval_kind_unsupported");
      this.store.db.prepare("UPDATE questions SET state='answering',answer_hash=? WHERE question_id=? AND state='pending'").run(digest,id);
      rpc.respond(JSON.parse(q.rpc_id_json),response);return this.store.question(id)!;
    });
  }
  async stop(name:string,generation:string):Promise<AgentRecord> {
    // queue待機中のhost crashでもintentを失わない。generationに束縛して保存する。
    const row=this.store.agent(name);
    if(!row||row.generation!==generation)throw Error("runtime_stop_identity_changed");
    if(row.state!=="stopped") {
      if(!row.pid||!row.process_start)throw Error("runtime_process_stop_evidence_missing");
      const root:ProcessIdentity={pid:row.pid,parent:0,group:row.pid,uid:process.getuid!(),start:row.process_start,state:"unknown"};
      this.store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopping') ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,processes_json=excluded.processes_json,state='stopping' WHERE stops.generation<>excluded.generation").run(name,generation,JSON.stringify([root]));
    }
    return this.serialized(name,()=>this.stopAgent(name,generation));
  }
  private async stopAgent(name:string,generation:string):Promise<AgentRecord> {
    const row=this.store.agent(name);if(!row||row.generation!==generation)throw Error("runtime_stop_identity_changed");
    if(row.state==="stopped")return row;
    if(!row.pid||!row.process_start)throw Error("runtime_process_stop_evidence_missing");
    const saved=this.store.db.prepare("SELECT processes_json FROM stops WHERE agent=? AND generation=?").get(name,generation) as {processes_json:string}|undefined;
    const root:ProcessIdentity={pid:row.pid,parent:0,group:row.pid,uid:process.getuid!(),start:row.process_start,state:"unknown"};
    await stopScope(root,saved?JSON.parse(saved.processes_json):[],rows=>this.store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopping') ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,processes_json=excluded.processes_json,state='stopping'").run(name,generation,JSON.stringify(rows)));
    this.store.db.transaction(()=>{
      this.store.db.prepare("UPDATE stops SET state='stopped' WHERE agent=? AND generation=?").run(name,generation);
      this.store.db.prepare("UPDATE questions SET state='expired' WHERE agent=? AND generation=? AND state IN ('pending','answering')").run(name,generation);
      this.store.change(name,generation,{state:"stopped",turn_id:null});
    }).immediate();
    this.connections.delete(name);return this.store.agent(name)!;
  }
  /** workerは停止intentだけ再開する。mainのみ、停止証明の後に新threadで再生成する。 */
  async recover():Promise<void> {
    for(const candidate of this.store.agents()) {
      if((this.recoveryAfter.get(candidate.name)??0)>Date.now())continue;
      const intent=this.store.db.prepare("SELECT 1 FROM main_recoveries WHERE agent=? AND generation=?").get(candidate.name,candidate.generation);
      const pending=this.store.db.prepare("SELECT 1 FROM stops WHERE agent=? AND generation=?").get(candidate.name,candidate.generation);
      if(!intent&&!pending&&(candidate.role!=="main"||this.status(candidate.name)?.state!=="unknown"))continue;
      this.recoveryAfter.set(candidate.name,Date.now()+30_000);
      await this.serialized(candidate.name,async()=>{
        const current=this.store.agent(candidate.name);
        if(!current||current.generation!==candidate.generation)return;
        let recovery=this.store.db.prepare("SELECT input_json FROM main_recoveries WHERE agent=? AND generation=?").get(current.name,current.generation) as {input_json:string}|undefined;
        if(!recovery) {
          if(current.state==="stopped")return;
          const interrupted=this.store.db.prepare("SELECT 1 FROM stops WHERE agent=? AND generation=?").get(current.name,current.generation);
          if(interrupted){await this.stopAgent(current.name,current.generation);return;}
          if(current.role!=="main"||this.status(current.name)?.state!=="unknown")return;
          recovery={input_json:current.config_json};
          this.store.db.prepare("INSERT INTO main_recoveries VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,input_json=excluded.input_json").run(current.name,current.generation,recovery.input_json);
        }
        if(current.state!=="stopped")await this.stopAgent(current.name,current.generation);
        await this.startAgent(JSON.parse(recovery.input_json) as StartAgent);
        this.store.db.prepare("DELETE FROM main_recoveries WHERE agent=? AND generation=?").run(current.name,current.generation);
      }).catch(()=>{});
    }
  }
}
