import path from "node:path";
import fs from "node:fs/promises";
import type {DispatcherConfig} from "../config.js";
import type {HerdrClient,HerdrCommandResult} from "../herdr.js";
import {WorkerStopNotSentError,PreparedWorkspaceCleanupError,codexAgentArguments,parseScheduledMcpInventory,runProcess,type JobAgentRuntime,type PreparedJobRuntime} from "../job-runtime.js";
import {JobWorkspace} from "../job-workspace.js";
import {workspaceJobId,processGroups,type WorkerObservation} from "../job-handoff.js";
import {jobProgressPath,workspaceFromJob} from "../job-prompt.js";
import type {JobRow} from "../types.js";
import {RuntimeClient,RuntimeResponseError} from "./client.js";

import type {AgentRecord} from "./store.js";
import {processes} from "./process.js";
import {scheduledExecutablePaths,verifyScheduledSandbox} from "../scheduled-sandbox.js";

export function runtimeSocket(config:DispatcherConfig):string{return process.env.DONA_APP_SERVER_SOCKET??path.join(path.dirname(config.updaterSocketPath),"runtime.sock");}
function result(row:AgentRecord|null,error?:string):HerdrCommandResult {
  if(row?.state==="interrupted")error="runtime_turn_interrupted";
  const ok=!!row&&["idle","working","waiting","interrupted"].includes(row.state);
  if(row&&!["stopped","idle","working","waiting","interrupted"].includes(row.state))error="runtime_observation_unknown";
  const state=row?.state==="working"?"working":row?.state==="waiting"?"blocked":["idle","interrupted"].includes(row?.state??"")?"idle":"unknown";
  return {ok:ok&&!error,stdout:row?JSON.stringify({result:{type:"agent_info",name:row.name,agent_name:row.name,workspace_id:row.name,pane_id:row.name,agent_session:{kind:"id",value:JSON.stringify([row.generation,row.thread_id])},status:state}}):"",stderr:error??"",exitCode:ok&&!error?0:1,timedOut:false,aborted:false,
    ...(error||!ok?{errorCode:error??"agent_not_running"}:row?.state==="waiting"?{errorCode:"runtime_question_pending"}:{}),agentStatus:state,
    ...(row?.thread_id?{agentIdentity:JSON.stringify([row.name,row.name,row.name,JSON.stringify([row.generation,row.thread_id])])}:{}),...(row?{stateChangeSeq:row.sequence}:{})};
}
export class AppServerAgentClient implements HerdrClient {
  readonly client:RuntimeClient;
  constructor(socket:string,readonly name:string,private readonly waitMs:number){this.client=new RuntimeClient(socket,95_000);}
  async get():Promise<HerdrCommandResult>{try{
    const row=await this.client.status(this.name);
    // 前turnの失敗と、次の独立eventを受け取れる状態は区別する。失敗eventは再送しない。
    if(row?.role==="main"&&row.state==="interrupted") {
      if(row.recovery_hint?.reason==="capacity_wait"&&Date.parse(row.recovery_hint.retry_after??"")>Date.now())return result(null,"runtime_capacity_wait");
      return result({...row,state:"idle"});
    }
    return result(row);
  }catch{return result(null,"runtime_observation_unknown");}}
  async prompt(text:string,_signal?:AbortSignal,key?:string):Promise<HerdrCommandResult>{return this.submit(text,key);}
  async submit(text:string,key?:string):Promise<HerdrCommandResult>{
    if(!key)return result(null,"runtime_operation_key_required");
    let receipt:{turnId:string};
    try{receipt=await this.client.prompt(this.name,key,text);}catch(error){
      const unsent=(error instanceof RuntimeResponseError&&error.status===409&&error.code==="runtime_not_ready")||["ECONNREFUSED","ENOENT"].includes((error as NodeJS.ErrnoException).code??"");
      return result(null,unsent?"agent_not_running":"steer_acceptance_unknown");
    }
    // 受理済みreceiptを、その後のstatus照会失敗で受付不明へ戻さない。
    try{return {...result(await this.client.status(this.name)),ok:true};}
    catch{return {ok:true,stdout:JSON.stringify(receipt),stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working"};}
  }
  async wait(signal?:AbortSignal):Promise<HerdrCommandResult>{
    const until=Date.now()+this.waitMs;
    do {
      let observed:HerdrCommandResult;
      try{observed=result(await this.client.status(this.name));}catch{observed=result(null,"runtime_observation_unknown");}
      if(!observed.ok||observed.agentStatus!=="working")return observed;
      if(signal?.aborted)return {...observed,ok:false,aborted:true};
      await new Promise(resolve=>setTimeout(resolve,250));
    }while(Date.now()<until);
    return {...await this.get(),ok:false,timedOut:true};
  }
}

/** legacyのDB列名は履歴保持のため残すが、値はApp Server agent/thread identity。 */
export class AppServerJobRuntime implements JobAgentRuntime {
  readonly client:RuntimeClient;
  constructor(private readonly config:DispatcherConfig,private progressEnabled=true,private readonly expectedSession?:(jobId:string)=>string|undefined,private readonly taskOwned:(jobId:string)=>boolean=()=>false){this.client=new RuntimeClient(runtimeSocket(config),95_000);}
  private matchesSession(row:JobRow,agent:AgentRecord):boolean {
    if(!this.expectedSession)return true;
    const expected=this.expectedSession(row.job_id);
    const legacy=JSON.parse(agent.config_json);
    if(legacy.legacyPaneId)return expected===agent.thread_id||(expected===undefined&&agent.thread_id===null&&agent.state==="stopped"&&agent.request_hash==="legacy-stopped"&&agent.name===row.agent_name&&legacy.legacyWorkspaceId===row.herdr_workspace_id&&legacy.legacyPaneId===row.herdr_pane_id);
    if(expected===undefined)return false;
    const identity=JSON.parse(expected) as unknown;
    return Array.isArray(identity)&&identity[0]===agent.generation&&(identity[1]===agent.thread_id||identity[1]===null);
  }
  async reconcilePreparation(row:JobRow):Promise<PreparedJobRuntime|undefined>{
    const agent=await this.client.status(row.agent_name);
    if(!agent||agent.name!==row.agent_name||agent.role!=="worker"||agent.cwd!==row.workspace_path||JSON.parse(agent.config_json).attemptId!==row.job_id)return;
    return {herdrWorkspaceId:agent.name,herdrPaneId:agent.name,herdrAgentSessionId:JSON.stringify([agent.generation,agent.thread_id])};
  }
  async recoveryHint(row:JobRow){const agent=await this.client.status(row.agent_name);return agent&&this.matchesSession(row,agent)?agent.recovery_hint:undefined;}
  pendingQuestions(after?:string){return this.client.call<import("./store.js").QuestionRecord[]>("pendingQuestions",{after});}
  questions(name:string,includeResolved=false){return this.client.questions(name,includeResolved);}
  approveRequest(name:string,id:string,accepted:boolean){return this.client.call<import("./store.js").QuestionRecord>("approve",{name,id,accepted});}
  answerQuestion(name:string,id:string,answers:Record<string,{answers:string[]}>){return this.client.answer(name,id,answers);}
  disableProgress():void{this.progressEnabled=false;}
  async prepare(row:JobRow,signal?:AbortSignal):Promise<PreparedJobRuntime>{
    const workspace=workspaceFromJob(row),provisioner=new JobWorkspace(this.config);
    const expected=workspace.kind==="scratch"?path.join(this.config.jobsWorkspaceRoot,"scratch",workspaceJobId(row)):
      path.join(this.config.jobsWorkspaceRoot,"github",...workspace.repository.split("/"),"worktrees",workspaceJobId(row));
    if(row.workspace_path!==expected)throw Error("runtime_workspace_mismatch");
    await fs.mkdir(this.config.jobsWorkspaceRoot,{recursive:true,mode:0o700});
    await fs.chmod(this.config.jobsWorkspaceRoot,0o700);
    // 通常Taskは既存Mac環境を利用する。scheduleのread-only制約を通常Taskへ流用しない。
    if(workspace.kind==="scratch") {
      if(workspaceJobId(row)!==row.job_id) {
        const prior=await fs.lstat(expected);if(prior.isSymbolicLink()||!prior.isDirectory())throw Error("runtime_continuation_workspace_missing");
      }else await fs.mkdir(expected,{recursive:true,mode:0o700});
    }
    else if(workspaceJobId(row)!==row.job_id)await provisioner.verifyContinuationWorktree(row,workspace.repository,signal);
    else {const created=await provisioner.createGitHubWorktree(row,workspace.repository,workspace.base_ref,signal);if(!created.ok)throw Error("runtime_workspace_preparation_failed");}
    if((await fs.lstat(expected)).isSymbolicLink())throw Error("runtime_workspace_symlink");
    await fs.chmod(expected,0o700);
    await fs.mkdir(path.dirname(row.result_path),{recursive:true,mode:0o700});
    await fs.chmod(path.dirname(row.result_path),0o700);
    if(this.progressEnabled){await fs.mkdir(path.dirname(jobProgressPath(row)),{recursive:true,mode:0o700});await fs.chmod(path.dirname(jobProgressPath(row)),0o700);}
    let executablePaths:string[]=[],disabledMcpServers:string[]=[];
    if(row.source==="dona_schedule") {
      if(workspace.kind!=="scratch")throw Error("runtime_schedule_workspace_invalid");
      executablePaths=await scheduledExecutablePaths(this.config.codexPath);
      await verifyScheduledSandbox(path.dirname(row.result_path),executablePaths,row.workspace_path,this.config.jobCommandTimeoutMs,
        (executable,args,timeout)=>runProcess(executable,args,timeout,signal));
    }
    const baseline=codexAgentArguments(row,this.config,[],this.progressEnabled,executablePaths);
    const trust=baseline.find(value=>value.startsWith("projects = "))!;
    // launchd may omit Node from PATH even though this process uses a pinned Node.
    // Codex's npm entrypoint has an /usr/bin/env node shebang.
    const inventoryEnv={...process.env,PATH:[path.dirname(process.execPath),process.env.PATH].filter(Boolean).join(path.delimiter)};
    const listed=await runProcess(this.config.codexPath,["-c",trust,"mcp","list","--json"],this.config.jobCommandTimeoutMs,signal,false,"",row.workspace_path,inventoryEnv);
    if(!listed.ok)throw Error("runtime_mcp_inventory_failed");
    disabledMcpServers=parseScheduledMcpInventory(JSON.parse(listed.stdout)).filter(name=>row.source==="dona_schedule"||["dona_slack","dona_dispatcher"].includes(name));
    const args=baseline;
    // --add-dir はTUI/exec専用。App Serverではthread configの追加rootとして渡す。
    const serverArgs:string[]=disabledMcpServers.flatMap(name=>["-c",`mcp_servers.${name}.enabled=false`]),writeRoots:string[]=[];
    for(let i=0;i<args.length;i++){if(args[i]==="--add-dir"){writeRoots.push(args[++i]!);}else if(["--model","-C","--ask-for-approval"].includes(args[i]!)){i++;}else serverArgs.push(args[i]!);}
    const interactive=row.source!=="dona_schedule"&&this.taskOwned(row.job_id);
    serverArgs.push("-c",`features.default_mode_request_user_input=${interactive}`);
    let agent:AgentRecord;
    try {agent=await this.client.start({attemptId:row.job_id,name:row.agent_name,role:"worker",cwd:row.workspace_path,release:path.resolve(import.meta.dirname,"../../.."),args:serverArgs,
      threadConfig:{model:"gpt-6.1-sol",approvalsReviewer:"user",...(!interactive?{approvalPolicy:"never"}:{}),config:{"sandbox_workspace_write.writable_roots":writeRoots,"features.default_mode_request_user_input":interactive},developerInstructions:!interactive?"このjobには対話回答の経路がありません。native request_user_inputは使わず、承認済みscopeで進められない場合は不足情報をblocked Resultへ記録してください。":"あなたはDonaのworkerです。必要な質問はrequest_user_inputで親Donaへ送れます。hostが質問を親に届けるため、ユーザーへの直接連絡やSlack操作は行わないでください。回答を待つ間も独立した作業は進められます。質問待ちは失敗ではなく、質問のためにfailed Resultを公開しないでください。"}});
    } catch(error) {
      // 接続前の失敗だけが未送信。応答喪失ではstartを再送せず、永続Attempt bindingを照合する。
      if(["ECONNREFUSED","ENOENT"].includes((error as NodeJS.ErrnoException).code??""))throw Error("runtime_start_not_sent");
      const recovered=await this.reconcilePreparation(row).catch(()=>undefined);
      throw new PreparedWorkspaceCleanupError("App Server preparation requires runtime reconciliation",row.agent_name,row.agent_name,recovered?.herdrAgentSessionId,"runtime_preparation_unknown");
    }
    if(!agent.thread_id)throw new PreparedWorkspaceCleanupError("App Server thread identity missing",row.agent_name,row.agent_name,JSON.stringify([agent.generation,null]),"runtime_preparation_unknown");
    return {herdrWorkspaceId:agent.name,herdrPaneId:agent.name,herdrAgentSessionId:JSON.stringify([agent.generation,agent.thread_id])};
  }
  async get(name:string):Promise<HerdrCommandResult>{return new AppServerAgentClient(runtimeSocket(this.config),name,this.config.agentWaitTimeoutMs).get();}
  async prompt(name:string,text:string,_signal?:AbortSignal,_timeout?:number,_submissionOnly?:boolean,key?:string):Promise<HerdrCommandResult>{return new AppServerAgentClient(runtimeSocket(this.config),name,this.config.agentWaitTimeoutMs).submit(text,key);}
  async wait(name:string,signal?:AbortSignal):Promise<HerdrCommandResult>{return new AppServerAgentClient(runtimeSocket(this.config),name,this.config.agentWaitTimeoutMs).wait(signal);}
  async listAgents():Promise<HerdrCommandResult>{const rows=await this.client.list();return {ok:true,stdout:JSON.stringify({result:{type:"agent_list",agents:rows.filter(r=>r.state!=="stopped").map(r=>({name:r.name,pane_id:r.name}))}}),stderr:"",exitCode:0,timedOut:false,aborted:false};}
  async cancel(name:string):Promise<HerdrCommandResult>{
    let row:AgentRecord|null;
    try{row=await this.client.status(name);}catch{return result(null,"cancel_not_sent");}
    if(!row)return result(null,"agent_not_found");
    try{await this.client.stop(name,row.generation);return {ok:true,stdout:"{}",stderr:"",exitCode:0,timedOut:false,aborted:false};}
    catch{return result(null,"cancel_acceptance_unknown");}
  }
  async closeAgent(name:string):Promise<HerdrCommandResult>{return this.cancel(name);}
  async cleanup(row:JobRow):Promise<HerdrCommandResult>{
    if(row.source!=="dona_schedule"||workspaceFromJob(row).kind!=="scratch"||!(["completed","failed","cancelled"].includes(row.status)||(row.status==="needs_review"&&row.last_error_code==="workspace_cleanup_failed")))throw Error("runtime_cleanup_scope_invalid");
    const expected=path.join(this.config.jobsWorkspaceRoot,"scratch",workspaceJobId(row));
    const canonicalExpected=path.join(await fs.realpath(this.config.jobsWorkspaceRoot),"scratch",workspaceJobId(row));
    if(row.workspace_path!==expected||await fs.realpath(path.dirname(expected))!==path.dirname(canonicalExpected))throw Error("runtime_cleanup_path_invalid");
    const stat=await fs.lstat(expected).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
    if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw Error("runtime_cleanup_path_invalid");
    await this.retireWorker(row);
    if(!await this.workerRetired(row))throw Error("runtime_cleanup_stop_unconfirmed");
    // stop receiptは再照合可能なので、削除途中の再実行も同じ世代へ束縛される。
    if(stat&&await fs.realpath(expected)!==canonicalExpected)throw Error("runtime_cleanup_path_invalid");
    await fs.rm(expected,{recursive:true,force:true});
    return {ok:true,stdout:"{}",stderr:"",exitCode:0,timedOut:false,aborted:false};
  }
  async observeWorker(row:JobRow):Promise<WorkerObservation>{
    const unknown=(reason:string):WorkerObservation=>({state:"unknown",reason,observed_at:new Date().toISOString(),process_ids:[],process_groups:[]});
    try {
      const agent=await this.client.status(row.agent_name);
      if(!agent||!this.matchesSession(row,agent))return unknown("runtime_identity_missing");
      const legacy=JSON.parse(agent.config_json) as {legacyWorkspaceId?:string;legacyPaneId?:string;processGroups?:number[]};
      if(row.herdr_workspace_id!==(legacy.legacyWorkspaceId??agent.name)||row.herdr_pane_id!==(legacy.legacyPaneId??agent.name))return unknown("runtime_identity_missing");
      if(!agent.pid){
        if(agent.state==="stopped")return {state:"stopped",reason:"app_server_verified_empty_scope",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
        return unknown("runtime_observation_unknown");
      }
      const sample=processes(),root=sample.find(p=>p.pid===agent.pid);
      if(agent.state!=="stopped"&&root&&root.start!==agent.process_start)return unknown("runtime_process_changed");
      const tree=agent.state==="stopped"?{process_ids:[agent.pid],process_groups:legacy.processGroups??[agent.pid]}:
        root?processGroups(sample.map(p=>`${p.pid} ${p.parent} ${p.group}`).join("\n"),agent.pid):{process_ids:[agent.pid,...sample.filter(p=>p.group===agent.pid).map(p=>p.pid)],process_groups:[agent.pid]};
      return {state:agent.state==="stopped"?"stopped":agent.state==="working"?"working":agent.state==="waiting"?"waiting":["idle","interrupted"].includes(agent.state)?"inactive":agent.state==="unknown"?"unreachable":"unknown",
        reason:"app_server_observed",observed_at:new Date().toISOString(),...tree};
    } catch{return unknown("runtime_query_failed");}
  }
  async retireWorker(row:JobRow):Promise<void>{let agent:AgentRecord|null;try{agent=await this.client.status(row.agent_name);}catch{throw new WorkerStopNotSentError("runtime_stop_not_sent");}if(!agent||!this.matchesSession(row,agent)||(agent.name!==row.herdr_pane_id&&JSON.parse(agent.config_json).legacyPaneId!==row.herdr_pane_id))throw Error("runtime_identity_changed");if(agent.state!=="stopped")await this.client.stop(agent.name,agent.generation);}
  async workerRetired(row:JobRow):Promise<boolean>{const agent=await this.client.status(row.agent_name);return !!agent&&this.matchesSession(row,agent)&&(agent.name===row.herdr_pane_id||JSON.parse(agent.config_json).legacyPaneId===row.herdr_pane_id)&&agent.state==="stopped";}
}
