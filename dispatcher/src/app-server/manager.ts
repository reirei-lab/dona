import {ExternalToolQueue,externalReplyTool} from "./external-tools.js";
import { createHash,randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppServerRpc,type RpcMessage,RpcFailure,RpcSpawnFailure } from "./rpc.js";
import {stableStringify} from "../validation.js";
import {projectHistory,projectNotification,projectItem,type ConversationIdentity,type ConversationSnapshot} from "./observation.js";
import { RuntimeStore,type AgentRecord,type QuestionRecord } from "./store.js";
import { identity,processes,same,stopScope,type ProcessIdentity } from "./process.js";

export const hash=(value:unknown)=>createHash("sha256").update(stableStringify(value)).digest("hex");
export interface StartAgent {attemptId?:string;name:string;role:"main"|"worker";cwd:string;release:string;args:string[];threadConfig:Record<string,unknown>}
export type RpcFactory=(args:string[],cwd:string,agent?:AgentRecord,attach?:boolean)=>AppServerRpc;
const object=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};

export class AppServerManager {
  readonly external:ExternalToolQueue;
  private connections=new Map<string,AppServerRpc>();
  private resets=new Map<string,string>();
  private queues=new Map<string,Promise<unknown>>();
  private recoveryAfter=new Map<string,number>();
  constructor(readonly store:RuntimeStore,private readonly factory:RpcFactory,private readonly reconnect=false,private readonly processSample=processes) {
    this.external=new ExternalToolQueue(store);this.external.expireRestart();
    store.db.exec("CREATE TABLE IF NOT EXISTS startup_phases(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,phase TEXT NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS main_readiness(agent TEXT PRIMARY KEY,generation TEXT NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS turn_outcomes(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,state TEXT NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS main_recoveries(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,input_json TEXT NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS recovery_hints(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,reason TEXT NOT NULL,retry_after TEXT)");
    store.db.exec("CREATE TABLE IF NOT EXISTS stops(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,processes_json TEXT NOT NULL,state TEXT NOT NULL)");
    for(const row of store.agents())if(row.state!=="stopped")store.observe(row.name,row.generation,{kind:"gap"});
    // 再接続していないprocessをidleとみなさない。永続receiptは残す。
    store.db.prepare("UPDATE questions SET state='expired' WHERE state IN ('pending','answering')").run();
    store.db.prepare("UPDATE agents SET state='unknown',sequence=sequence+1 WHERE state<>'stopped'").run();
  }
  closeConnections():void {for(const rpc of this.connections.values())rpc.closeConnection();this.connections.clear();}
  serialized<T>(name:string,action:()=>Promise<T>):Promise<T> {
    const previous=this.queues.get(name)??Promise.resolve();const next=previous.catch(()=>{}).then(action);
    this.queues.set(name,next);void next.finally(()=>{if(this.queues.get(name)===next)this.queues.delete(name);}).catch(()=>{});return next;
  }
  async start(input:StartAgent):Promise<AgentRecord> {
    return this.serialized(input.name,()=>this.startAgent(input));
  }
  private async startAgent(input:StartAgent,recoveryGeneration?:string):Promise<AgentRecord> {
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(input.name)||!path.isAbsolute(input.cwd)||!path.isAbsolute(input.release)||!fs.statSync(input.cwd).isDirectory())throw Error("runtime_start_scope");
      const requestHash=hash(input),prior=this.store.agent(input.name);
      if(prior&&prior.state!=="stopped") {
        if(prior.request_hash!==requestHash)throw Error("runtime_agent_conflict");
        if(!this.connections.get(input.name)?.connected||!prior.thread_id||!["idle","working","waiting","interrupted"].includes(prior.state))throw Error("runtime_agent_recovery_required");
        return prior;
      }
      const row:AgentRecord={name:input.name,generation:randomUUID(),role:input.role,cwd:input.cwd,release:input.release,
        thread_id:input.role==="worker"?(prior?.thread_id??null):null,turn_id:null,pid:null,process_start:null,state:"starting",request_hash:requestHash,config_json:JSON.stringify(input),sequence:0};
      this.store.db.transaction(()=>{
        this.store.put(row);
        this.store.db.prepare("INSERT INTO startup_phases VALUES(?,?,'not_sent') ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,phase=excluded.phase").run(row.name,row.generation);
        if(recoveryGeneration)this.store.db.prepare("UPDATE main_recoveries SET generation=? WHERE agent=? AND generation=?").run(row.generation,row.name,recoveryGeneration);
      }).immediate();
      let rpc:AppServerRpc;
      try {
        rpc=this.factory(input.args,input.cwd,row);this.connections.set(input.name,rpc);
        // PIDなしの非同期spawn errorだけを待つ。PIDがある場合はawait前にidentityを保存する。
        if(!rpc.child.pid)await rpc.confirmSpawn();
      }catch(error){
        if(error instanceof RpcSpawnFailure)this.store.db.transaction(()=>{
          this.store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopped') ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,processes_json=excluded.processes_json,state='stopped'").run(row.name,row.generation,"[]");
          this.store.change(row.name,row.generation,{state:"stopped",turn_id:null});this.connections.delete(row.name);
        }).immediate();
        throw error;
      }
      // spawn直後のPIDを他のawaitより前に保存する。開始identityが取得できなければ準備は未確定。
      const pid=rpc.child.pid;if(!pid)throw Error("runtime_spawn_identity_missing");
      const processIdentity=identity(pid);if(!processIdentity)throw Error("runtime_process_identity_missing");
      row.pid=pid;row.process_start=processIdentity.start;this.store.put(row);
      this.bind(row,rpc);
      try {
        await rpc.initialize();
        const params={...input.threadConfig,...(object(input.threadConfig.config)["features.default_mode_request_user_input"]!==false?{dynamicTools:[externalReplyTool]}:{}),cwd:input.cwd,...(row.thread_id?{threadId:row.thread_id,excludeTurns:true}:{})};
        this.store.db.prepare("UPDATE startup_phases SET phase='sending' WHERE agent=? AND generation=?").run(row.name,row.generation);
        const result=object(await rpc.request(row.thread_id?"thread/resume":"thread/start",params,90_000));
        const thread=object(result.thread);if(typeof thread.id!=="string")throw Error("runtime_thread_identity_missing");
        this.store.change(row.name,row.generation,{thread_id:thread.id,state:"idle"});
        this.store.db.prepare("UPDATE startup_phases SET phase='ready' WHERE agent=? AND generation=?").run(row.name,row.generation);
        return this.store.agent(row.name)!;
      } catch(error){
        this.store.change(row.name,row.generation,{state:"unknown"});
        const phase=this.store.db.prepare("SELECT phase FROM startup_phases WHERE agent=? AND generation=?").get(row.name,row.generation) as {phase:string};
        if(phase.phase==="not_sent"||(error instanceof RpcFailure&&["not_sent","rejected"].includes(error.acceptance))){
          this.store.db.prepare("UPDATE startup_phases SET phase='not_sent' WHERE agent=? AND generation=?").run(row.name,row.generation);
          await this.stopAgent(row.name,row.generation);throw Error("runtime_start_not_sent");
        }
        throw error;
      }
  }
  private bind(row:AgentRecord,rpc:AppServerRpc):void {
      rpc.on("request",(message:RpcMessage)=>this.onRequest(row,message));
      rpc.on("notification",(message:RpcMessage)=>this.onNotification(row,message));
      rpc.on("disconnect",()=>{
        if(!this.store.db.open||this.store.agent(row.name)?.generation!==row.generation)return;
        this.store.db.prepare("UPDATE questions SET state='expired' WHERE agent=? AND generation=? AND state IN ('pending','answering')").run(row.name,row.generation);
        this.external.expireAgent(row.name,row.generation);
        this.store.observe(row.name,row.generation,{kind:"gap"});
        if(this.store.agent(row.name)?.state!=="stopped")this.store.change(row.name,row.generation,{state:"unknown"});
      });
  }
  private observationIdentity(row:AgentRecord,sample?:ProcessIdentity[]):ConversationIdentity {
    const input=JSON.parse(row.config_json) as StartAgent;
    return {name:row.name,generation:row.generation,role:row.role,thread_id:row.thread_id,attempt_id:input.attemptId??null,state:this.status(row.name,sample)?.state??"unknown",connected:!!this.connections.get(row.name)?.connected,observed_at:new Date().toISOString()};
  }
  conversations(after=""):{items:ConversationIdentity[];next:string|null} {
    if(after.length>128)throw Error("runtime_conversation_cursor_invalid");
    const rows=this.store.db.prepare("SELECT * FROM agents WHERE name>? ORDER BY name LIMIT 101").all(after) as AgentRecord[];
    const sample=this.processSample();
    return {items:rows.slice(0,100).map(row=>this.observationIdentity(row,sample)),next:rows.length>100?rows[99]!.name:null};
  }
  conversationHistory(name:string,afterGeneration="") {
    if(name.length>160||afterGeneration.length>160)throw Error("runtime_conversation_cursor_invalid");
    return this.store.conversationHistory(name,afterGeneration);
  }
  async conversation(name:string,generation:string,afterSequence?:number):Promise<ConversationSnapshot> {
    if(afterSequence!==undefined&&(!Number.isSafeInteger(afterSequence)||afterSequence<0))throw Error("runtime_conversation_cursor_invalid");
    const row=this.store.agent(name);
    if(!row||row.generation!==generation){
      const archived=this.store.archivedConversation(name,generation);if(!archived)throw Error("runtime_conversation_not_current");
      // 過去generationはDonaが観測済みの投影だけ。現workerや個人Codexへ接続しない。
      this.store.expireObservations();
      return {name:archived.name,generation:archived.generation,role:archived.role,thread_id:archived.thread_id,
        attempt_id:archived.attempt_id,state:"unknown",connected:false,archived:true,observed_at:new Date().toISOString(),
        ...this.store.observations(name,generation,afterSequence),items:this.store.cachedItems(name,generation),gap:true,truncated:true};
    }
    // watermarkを履歴要求前に固定する。履歴と通知の重なりはあり得るが、要求中の通知を飛ばさない。
    const observations=this.store.observations(name,generation,afterSequence),rpc=this.connections.get(name);
    let history:{items:ConversationSnapshot["items"];truncated:boolean}={items:this.store.cachedItems(name,generation),truncated:true},gap=observations.gap;
    if(row.thread_id&&rpc?.connected){
      try {const metadata=object(await rpc.request("thread/read",{threadId:row.thread_id,includeTurns:false}));
        if(object(metadata.thread).id!==row.thread_id)throw Error("runtime_conversation_identity_mismatch");
        const page=object(await rpc.request("thread/turns/list",{threadId:row.thread_id,limit:20,sortDirection:"desc",itemsView:"full"}));
        const result=projectHistory({thread:{id:row.thread_id,turns:Array.isArray(page.data)?[...page.data].reverse():[]}});
        history={items:result.items,truncated:result.truncated||typeof page.nextCursor==="string"};
      }catch{gap=true;}
    }else gap=true;
    const current=this.store.agent(name);if(!current||current.generation!==generation||current.thread_id!==row.thread_id)throw Error("runtime_conversation_not_current");
    return {...this.observationIdentity(current),...observations,...history,gap};
  }
  status(name:string,sample?:ProcessIdentity[]):AgentRecord|undefined {
    const row=this.store.agent(name);if(!row)return;
    const phase=this.store.db.prepare("SELECT phase FROM startup_phases WHERE agent=? AND generation=?").get(row.name,row.generation) as {phase:"not_sent"|"sending"|"ready"}|undefined;
    if(phase)row.startup_state=phase.phase;
    if(row.role==="main")row.startup_ready=!!this.store.db.prepare("SELECT 1 FROM main_readiness WHERE agent=? AND generation=?").get(row.name,row.generation);
    const hint=this.store.db.prepare("SELECT reason,retry_after FROM recovery_hints WHERE agent=? AND generation=?").get(name,row.generation) as {reason:"capacity_wait"|"authorization_required"|"configuration_error";retry_after:string|null}|undefined;
    if(hint)row.recovery_hint={reason:hint.reason,...(hint.retry_after?{retry_after:hint.retry_after}:{})};
    if(row.state==="stopped") {
      const stop=this.store.db.prepare("SELECT processes_json FROM stops WHERE agent=? AND generation=? AND state='stopped'").get(name,row.generation) as {processes_json:string}|undefined;
      if(!stop)return {...row,state:"unknown"};
      const table=sample??this.processSample();
      if((JSON.parse(stop.processes_json) as ProcessIdentity[]).some(p=>{const live=table.find(x=>x.pid===p.pid);return same(p,live)&&!live!.state.includes("Z");}))return {...row,state:"unknown"};
    }
    if(row.state!=="stopped"&&(!this.connections.get(name)?.connected||!row.pid||(sample??this.processSample()).find(p=>p.pid===row.pid)?.start!==row.process_start))return {...row,state:"unknown"};
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
    if(message.method==="item/tool/call") {
      try{this.external.accept(current,message);this.store.change(agent.name,agent.generation,{state:"waiting"});}
      catch{this.connections.get(agent.name)?.respond(message.id,{success:false,contentItems:[{type:"inputText",text:"external_approval_request_denied"}]});}
      return;
    }
    const kind=message.method==="item/tool/requestUserInput"?"question":message.method?.includes("requestApproval")?"approval":message.method==="mcpServer/elicitation/request"?"elicitation":undefined;
    if(!kind){this.connections.get(agent.name)?.reject(message.id);return;}
    if(agent.role==="main") {
      this.connections.get(agent.name)?.reject(message.id,"Dona main must ask the user through the configured Slack tools, publish its event Result, and handle the reply as a new event.");return;
    }
    const settings=object(object(JSON.parse(current.config_json)).threadConfig);
    if(["question","approval"].includes(kind)&&object(settings.config)["features.default_mode_request_user_input"]===false) {
      this.connections.get(agent.name)?.reject(message.id,"This job has no interactive question or approval channel. Continue within the authorized scope or publish a blocked Result explaining the missing input.");return;
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
    const observation=projectNotification(message.method,p);if(observation)this.store.observe(row.name,row.generation,observation);
    if(["item/started","item/completed"].includes(message.method??"")&&typeof p.turnId==="string"){const item=projectItem(p.item,p.turnId);if(item)this.store.cacheItem(row.name,row.generation,item);}
    if(message.method==="turn/started") {
      const turn=object(p.turn);if(typeof turn.id==="string"){
        this.store.db.prepare("DELETE FROM turn_outcomes WHERE agent=? AND generation=?").run(agent.name,agent.generation);
        this.store.change(agent.name,agent.generation,{turn_id:turn.id,state:"working"});
      }
    } else if(message.method==="turn/completed") {
      const turn=object(p.turn);if(turn.id!==row.turn_id)return;
      if(row.role==="main"&&turn.status==="completed")this.store.db.prepare("INSERT INTO main_readiness VALUES(?,?) ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation").run(row.name,row.generation);
      const code=object(turn.error).codexErrorInfo;
      const reason=["usageLimitExceeded","rateLimitExceeded","flexUnavailable","serverOverloaded"].includes(String(code))?"capacity_wait":code==="unauthorized"?"authorization_required":["badRequest","sandboxError","cyberPolicy","misalignmentPolicyViolation","tooManyDenials"].includes(String(code))?"configuration_error":undefined;
      if(reason)this.store.db.prepare("INSERT INTO recovery_hints VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,reason=excluded.reason,retry_after=excluded.retry_after").run(agent.name,agent.generation,reason,reason==="capacity_wait"?(this.resets.get(agent.name)??new Date(Date.now()+900_000).toISOString()):null);
      this.store.db.prepare("INSERT INTO turn_outcomes VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,state=excluded.state").run(agent.name,agent.generation,turn.status==="completed"?"idle":"interrupted");
      // 非同期質問はturnが完了しても未解決であり得る。serverRequest/resolvedを終端証拠にする。
      this.store.change(agent.name,agent.generation,{turn_id:null,state:this.store.questions(agent.name).length||this.external.waiting(agent.name)?"waiting":turn.status==="completed"?"idle":"interrupted"});
    } else if(message.method==="serverRequest/resolved") {
      this.external.resolved(agent.name,agent.generation,p.requestId);
      this.store.db.prepare("UPDATE questions SET state=CASE WHEN state='answering' THEN 'resolved' ELSE 'expired' END WHERE agent=? AND generation=? AND rpc_id_json=? AND state IN ('pending','answering')")
        .run(agent.name,agent.generation,JSON.stringify(p.requestId));
      const terminal=this.store.db.prepare("SELECT state FROM turn_outcomes WHERE agent=? AND generation=?").get(agent.name,agent.generation) as {state:"idle"|"interrupted"}|undefined;
      if(this.store.questions(agent.name).length===0&&!this.external.waiting(agent.name))this.store.change(agent.name,agent.generation,{state:row.turn_id?"working":terminal?.state??"idle"});
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
  externalRequests(){return this.external.pending().map(row=>{try{return this.external.source(row);}catch{return {...row,source_event_id:null};}});}
  resolveExternal(name:string,id:string,result:{request_id:string|null;state:string}){
    const row=this.external.get(id),agent=this.store.agent(name),rpc=this.connections.get(name);
    if(!row||row.agent!==name||!agent||agent.generation!==row.generation||agent.thread_id!==row.thread_id||!rpc?.connected)throw Error("runtime_external_not_current");
    const resolved=this.external.resolve(id,result);
    if(row.state==="pending")rpc.respond(JSON.parse(row.rpc_id_json),{success:true,contentItems:[{type:"inputText",text:resolved.result_json!}]});
    if(!this.external.waiting(name)&&!this.store.questions(name).length)this.store.change(name,agent.generation,{state:agent.turn_id?"working":"idle"});
    return {request_id:id,state:resolved.state};
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
    this.store.db.prepare("DELETE FROM main_recoveries WHERE agent=? AND generation=?").run(name,generation);
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
      this.external.expireAgent(name,generation);
      this.store.change(name,generation,{state:"stopped",turn_id:null});
    }).immediate();
    this.connections.delete(name);return this.store.agent(name)!;
  }
  /** workerは停止intentだけ再開する。mainのみ、停止証明の後に新threadで再生成する。 */
  async recover():Promise<void> {
    this.store.expireObservations();
    for(const candidate of this.store.agents()) {
      if((this.recoveryAfter.get(candidate.name)??0)>Date.now())continue;
      const phase=this.store.db.prepare("SELECT phase FROM startup_phases WHERE agent=? AND generation=?").get(candidate.name,candidate.generation) as {phase:string}|undefined;
      if(candidate.state!=="stopped"&&phase?.phase==="not_sent"){
        await this.serialized(candidate.name,()=>this.stopAgent(candidate.name,candidate.generation)).catch(()=>{});continue;
      }
      if(this.reconnect&&candidate.state!=="stopped"&&candidate.pid&&identity(candidate.pid)?.start===candidate.process_start&&!this.store.db.prepare("SELECT 1 FROM stops WHERE agent=? AND generation=?").get(candidate.name,candidate.generation)){
        this.recoveryAfter.set(candidate.name,Date.now()+30_000);
        await this.serialized(candidate.name,async()=>{
          const row=this.store.agent(candidate.name);if(!row||row.generation!==candidate.generation)return;
          if(this.store.db.prepare("SELECT 1 FROM stops WHERE agent=? AND generation=?").get(row.name,row.generation))return;
          const input=JSON.parse(row.config_json) as StartAgent;
          let rpc=this.connections.get(row.name),initialize=false;
          if(!rpc?.connected){rpc=this.factory(input.args,input.cwd,row,true);this.connections.set(row.name,rpc);this.bind(row,rpc);initialize=true;}
          try {if(initialize)await rpc.initialize();if(row.thread_id){
            const result=object(await rpc.request("thread/read",{threadId:row.thread_id,includeTurns:false})),thread=object(result.thread);
            if(thread.id!==row.thread_id)throw Error("runtime_conversation_identity_mismatch");
            // 再接続で失われた質問の回答権限は復元しない。idleだけをread証拠から回復する。
            if(object(thread.status).type==="idle"&&this.store.agent(row.name)?.state==="unknown")this.store.change(row.name,row.generation,{state:"idle",turn_id:null});
          }}
          catch{rpc.closeConnection();}
        }).catch(()=>{});
        continue;
      }
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
        if(!this.store.db.prepare("SELECT 1 FROM main_recoveries WHERE agent=? AND generation=?").get(current.name,current.generation))return;
        const started=await this.startAgent(JSON.parse(recovery.input_json) as StartAgent,current.generation);
        this.store.db.prepare("DELETE FROM main_recoveries WHERE agent=? AND generation=?").run(current.name,started.generation);
      }).catch(()=>{});
    }
  }
}
