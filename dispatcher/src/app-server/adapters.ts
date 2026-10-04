import path from "node:path";
import fs from "node:fs/promises";
import type {DispatcherConfig} from "../config.js";
import type {HerdrClient,HerdrCommandResult} from "../herdr.js";
import {WorkerStopNotSentError,PreparedWorkspaceCleanupError,codexAgentArguments,parseScheduledMcpInventory,runProcess,type JobAgentRuntime,type PreparedJobRuntime} from "../job-runtime.js";
import {JobWorkspace} from "../job-workspace.js";
import {workspaceJobId,processGroups,type WorkerObservation} from "../job-handoff.js";
import {jobProgressPath,workspaceFromJob} from "../job-prompt.js";
import type {JobRow} from "../types.js";
import {RuntimeClient} from "./client.js";

import type {AgentRecord} from "./store.js";
import {processes} from "./process.js";
import {scheduledExecutablePaths,verifyScheduledSandbox} from "../scheduled-sandbox.js";

export function runtimeSocket(config:DispatcherConfig):string{return process.env.DONA_APP_SERVER_SOCKET??path.join(path.dirname(config.updaterSocketPath),"runtime.sock");}
function result(row:AgentRecord|null,error?:string):HerdrCommandResult {
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
  async get():Promise<HerdrCommandResult>{try{return result(await this.client.status(this.name));}catch{return result(null,"runtime_observation_unknown");}}
  async prompt(text:string,_signal?:AbortSignal,key?:string):Promise<HerdrCommandResult>{return this.submit(text,key);}
  async submit(text:string,key?:string):Promise<HerdrCommandResult>{
    if(!key)return result(null,"runtime_operation_key_required");
    let receipt:{turnId:string};
    try{receipt=await this.client.prompt(this.name,key,text);}catch{return result(null,"steer_acceptance_unknown");}
    // 受理済みreceiptを、その後のstatus照会失敗で受付不明へ戻さない。
    try{return {...result(await this.client.status(this.name)),ok:true};}
    catch{return {ok:true,stdout:JSON.stringify(receipt),stderr:"",exitCode:0,timedOut:false,aborted:false,agentStatus:"working"};}
  }
  async wait(signal?:AbortSignal):Promise<HerdrCommandResult>{
    const until=Date.now()+this.waitMs;
    do {
      const observed=await this.get();if(!observed.ok||observed.agentStatus!=="working")return observed;
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
    const legacy=JSON.parse(agent.config_json).legacyPaneId;
    return expected!==undefined&&expected===(legacy?agent.thread_id:JSON.stringify([agent.generation,agent.thread_id]));
  }
  async recoveryHint(row:JobRow){const agent=await this.client.status(row.agent_name);return agent&&this.matchesSession(row,agent)?agent.recovery_hint:undefined;}
  pendingQuestions(){return this.client.call<import("./store.js").QuestionRecord[]>("pendingQuestions");}
  questions(name:string,includeResolved=false){return this.client.questions(name,includeResolved);}
  approveRequest(name:string,id:string,accepted:boolean){return this.client.call<import("./store.js").QuestionRecord>("approve",{name,id,accepted});}
  answerQuestion(name:string,id:string,answers:Record<string,{answers:string[]}>){return this.client.answer(name,id,answers);}
  disableProgress():void{this.progressEnabled=false;}
  async prepare(row:JobRow,signal?:AbortSignal):Promise<PreparedJobRuntime>{
    const workspace=workspaceFromJob(row),provisioner=new JobWorkspace(this.config);
    const expected=workspace.kind==="scratch"?path.join(this.config.jobsWorkspaceRoot,"scratch",workspaceJobId(row)):
      path.join(this.config.jobsWorkspaceRoot,"github",...workspace.repository.split("/"),"worktrees",workspaceJobId(row));
    if(row.workspace_path!==expected)throw Error("runtime_workspace_mismatch");
    // 通常Taskは既存Mac環境を利用する。scheduleのread-only制約を通常Taskへ流用しない。
    if(workspace.kind==="scratch") {
      if(workspaceJobId(row)!==row.job_id) {
        const prior=await fs.lstat(expected);if(prior.isSymbolicLink()||!prior.isDirectory())throw Error("runtime_continuation_workspace_missing");
      }else await fs.mkdir(expected,{recursive:true,mode:0o700});
    }
    else if(workspaceJobId(row)!==row.job_id)await provisioner.verifyContinuationWorktree(row,workspace.repository,signal);
    else {const created=await provisioner.createGitHubWorktree(row,workspace.repository,workspace.base_ref,signal);if(!created.ok)throw Error("runtime_workspace_preparation_failed");}
    if((await fs.lstat(expected)).isSymbolicLink())throw Error("runtime_workspace_symlink");
    await fs.mkdir(path.dirname(row.result_path),{recursive:true,mode:0o700});
    if(this.progressEnabled)await fs.mkdir(path.dirname(jobProgressPath(row)),{recursive:true,mode:0o700});
    let executablePaths:string[]=[],disabledMcpServers:string[]=[];
    if(row.source==="dona_schedule") {
      if(workspace.kind!=="scratch")throw Error("runtime_schedule_workspace_invalid");
      executablePaths=await scheduledExecutablePaths(this.config.codexPath);
      await verifyScheduledSandbox(path.dirname(row.result_path),executablePaths,row.workspace_path,this.config.jobCommandTimeoutMs,
        (executable,args,timeout)=>runProcess(executable,args,timeout,signal));
    }
    const baseline=codexAgentArguments(row,this.config,[],this.progressEnabled,executablePaths);
    const trust=baseline.find(value=>value.startsWith("projects = "))!;
    const listed=await runProcess(this.config.codexPath,["-c",trust,"mcp","list","--json"],this.config.jobCommandTimeoutMs,signal,false,"",row.workspace_path);
    if(!listed.ok)throw Error("runtime_mcp_inventory_failed");
    disabledMcpServers=parseScheduledMcpInventory(JSON.parse(listed.stdout)).filter(name=>row.source==="dona_schedule"||["dona_slack","dona_dispatcher"].includes(name));
    const args=baseline;
    // --add-dir はTUI/exec専用。App Serverではthread configの追加rootとして渡す。
    const serverArgs:string[]=disabledMcpServers.flatMap(name=>["-c",`mcp_servers.${name}.enabled=false`]),writeRoots:string[]=[];
    for(let i=0;i<args.length;i++){if(args[i]==="--add-dir"){writeRoots.push(args[++i]!);}else if(["--model","-C","--ask-for-approval"].includes(args[i]!)){i++;}else serverArgs.push(args[i]!);}
    const interactive=row.source!=="dona_schedule"&&this.taskOwned(row.job_id);
    serverArgs.push("-c",`features.default_mode_request_user_input=${interactive}`);
    let agent:AgentRecord;
    try {agent=await this.client.start({name:row.agent_name,role:"worker",cwd:row.workspace_path,release:path.resolve(import.meta.dirname,"../../.."),args:serverArgs,
      threadConfig:{model:"gpt-6.1-sol",approvalsReviewer:"auto_review",...(row.source==="dona_schedule"?{approvalPolicy:"never"}:{}),config:{"sandbox_workspace_write.writable_roots":writeRoots,"features.default_mode_request_user_input":interactive},developerInstructions:!interactive?"このjobには対話回答の経路がありません。native request_user_inputは使わず、承認済みscopeで進められない場合は不足情報をblocked Resultへ記録してください。":"あなたはDonaのworkerです。必要な質問はrequest_user_inputで親Donaへ送れます。hostが質問を親に届けるため、ユーザーへの直接連絡やSlack操作は行わないでください。回答を待つ間も独立した作業は進められます。質問待ちは失敗ではなく、質問のためにfailed Resultを公開しないでください。"}});
    } catch {throw new PreparedWorkspaceCleanupError("App Server preparation requires runtime reconciliation",row.agent_name,row.agent_name);}
    if(!agent.thread_id)throw new PreparedWorkspaceCleanupError("App Server thread identity missing",row.agent_name,row.agent_name);
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
  async cleanup(row:JobRow):Promise<HerdrCommandResult>{return this.cancel(row.agent_name);}
  async observeWorker(row:JobRow):Promise<WorkerObservation>{
    const unknown=(reason:string):WorkerObservation=>({state:"unknown",reason,observed_at:new Date().toISOString(),process_ids:[],process_groups:[]});
    try {
      const agent=await this.client.status(row.agent_name);
      if(!agent||!this.matchesSession(row,agent))return unknown("runtime_identity_missing");
      const legacy=JSON.parse(agent.config_json) as {legacyWorkspaceId?:string;legacyPaneId?:string;processGroups?:number[]};
      if(row.herdr_workspace_id!==(legacy.legacyWorkspaceId??agent.name)||row.herdr_pane_id!==(legacy.legacyPaneId??agent.name))return unknown("runtime_identity_missing");
      if(!agent.pid)return unknown("runtime_observation_unknown");
      const sample=processes(),root=sample.find(p=>p.pid===agent.pid);
      if(agent.state!=="stopped"&&root&&root.start!==agent.process_start)return unknown("runtime_process_changed");
      const tree=agent.state==="stopped"?{process_ids:[agent.pid],process_groups:legacy.processGroups??[agent.pid]}:
        root?processGroups(sample.map(p=>`${p.pid} ${p.parent} ${p.group}`).join("\n"),agent.pid):{process_ids:[agent.pid,...sample.filter(p=>p.group===agent.pid).map(p=>p.pid)],process_groups:[agent.pid]};
      return {state:agent.state==="stopped"?"stopped":agent.state==="working"?"working":agent.state==="waiting"?"waiting":["idle","interrupted"].includes(agent.state)?"inactive":agent.state==="unknown"?"unreachable":"unknown",
        reason:"app_server_observed",observed_at:new Date().toISOString(),...tree};
    } catch{return unknown("runtime_query_failed");}
  }
  async retireWorker(row:JobRow):Promise<void>{let agent:AgentRecord|null;try{agent=await this.client.status(row.agent_name);}catch{throw new WorkerStopNotSentError("runtime_stop_not_sent");}if(!agent||!this.matchesSession(row,agent)||agent.name!==row.herdr_pane_id)throw Error("runtime_identity_changed");await this.client.stop(agent.name,agent.generation);}
  async workerRetired(row:JobRow):Promise<boolean>{const agent=await this.client.status(row.agent_name);return !!agent&&this.matchesSession(row,agent)&&(agent.name===row.herdr_pane_id||JSON.parse(agent.config_json).legacyPaneId===row.herdr_pane_id)&&agent.state==="stopped";}
}
