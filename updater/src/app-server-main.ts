import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type {UpdatePolicy} from "./policy.js";
import type {MainAgentObservation,MainAgentStartResult,MainAgentStopResult} from "./types.js";

interface RuntimeAgent {name:string;generation:string;thread_id:string|null;state:string;cwd:string;release:string;startup_ready?:boolean;}
const absent=(code:string):MainAgentObservation=>({exists:false,name:null,kind:null,pane_id:null,status:null,interactive_ready:false,working_directory:null,session_id:null,matches_release:false,error_code:code});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** stable runtime hostを通すmain lifecycle。Herdrは旧世代の復旧経路だけに残す。 */
export class AppServerMain {
 constructor(private readonly policy:UpdatePolicy){}
 private call<T>(action:string,input:Record<string,unknown>={}):Promise<T> {
  return new Promise((resolve,reject)=>{
   const body=JSON.stringify({action,...input}),request=http.request({socketPath:path.join(this.policy.control_root,"runtime.sock"),path:"/control",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},response=>{
    let data="";response.setEncoding("utf8");response.on("data",chunk=>{data+=chunk;if(data.length>1_048_576)response.destroy(Error("runtime_response_limit"));});response.on("error",reject);response.on("end",()=>{try{const value=JSON.parse(data);if(response.statusCode!==200)throw Error("runtime_control_failed");resolve(value.result);}catch(error){reject(error);}});
   });request.setTimeout(this.policy.timeouts.agent_start_ms+30_000,()=>request.destroy(Error("runtime_control_unknown")));request.on("error",reject);request.end(body);
  });
 }
 async status(release?:string):Promise<MainAgentObservation> {
  try {
   const agent=await this.call<RuntimeAgent|null>("status",{name:this.policy.main_agent.name});
   if(!agent||agent.state==="stopped")return absent("agent_not_running");
   if(!["idle","working","waiting"].includes(agent.state)||!agent.thread_id)return absent("runtime_observation_unknown");
   return {exists:true,name:agent.name,kind:"codex",pane_id:agent.name,status:agent.state==="waiting"?"blocked":agent.state==="working"?"working":"idle",interactive_ready:agent.startup_ready===true,
    working_directory:agent.cwd,session_id:agent.generation,matches_release:release===undefined||agent.release===release,error_code:null};
  }catch{return absent("runtime_observation_unknown");}
 }
 async waitIdle():Promise<MainAgentObservation> {
  const deadline=Date.now()+this.policy.timeouts.agent_drain_ms;let result:MainAgentObservation;
  do {result=await this.status();if(result.status!=="working")return result;await delay(100);}while(Date.now()<deadline);
  return result;
 }
 async stop(expected:MainAgentObservation):Promise<MainAgentStopResult> {
  const current=await this.status();
  if(!expected.exists||expected.status!=="idle"||current.status!=="idle"||current.name!==this.policy.main_agent.name||expected.name!==current.name||expected.session_id!==current.session_id||expected.pane_id!==current.pane_id)
   return {outcome:"rejected",pane_id:expected.pane_id,error_code:"main_agent_identity_changed"};
  try {
   const stopped=await this.call<RuntimeAgent>("stop",{name:current.name,generation:current.session_id});
   if(stopped.state!=="stopped"||stopped.generation!==current.session_id)throw Error();
   return {outcome:"stopped",pane_id:current.pane_id,error_code:null};
  }catch{return {outcome:"accepted_unknown",pane_id:current.pane_id,error_code:"main_agent_stop_unknown"};}
 }
 async start(name:string,release:string,previous?:string):Promise<MainAgentStartResult> {
  let sent=false;
  try {
   if(name!==this.policy.main_agent.name)throw Error();
   const [canonical,root,configStat]=await Promise.all([fs.realpath(release),fs.realpath(this.policy.release_root),fs.lstat(this.policy.config_root)]);
   if(canonical!==release||path.dirname(canonical)!==root||!/^[a-f0-9]{40}$/.test(path.basename(canonical))||configStat.isSymbolicLink()||configStat.uid!==process.getuid?.()||(configStat.mode&0o077))throw Error();
   for(const file of ["dispatcher.env","slack.env","mcp-dispatcher.mjs","mcp-slack.mjs"]){const stat=await fs.lstat(path.join(this.policy.config_root,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error();}
   const args=["-c","check_for_update_on_startup=false","-c","features.default_mode_request_user_input=false","-c",`projects = { ${JSON.stringify(release)} = { trust_level = "trusted" } }`,"-c",'model_reasoning_effort="low"'];
   for(const [server,file] of [["dona_dispatcher","dispatcher"],["dona_slack","slack"]]) {
    for(const [key,value] of Object.entries({command:this.policy.executables.node,args:[path.join(this.policy.config_root,`mcp-${file}.mjs`)],cwd:this.policy.config_root,required:true,enabled:true}))args.push("-c",`mcp_servers.${server}.${key}=${JSON.stringify(value)}`);
   }
   sent=true;
   const agent=await this.call<RuntimeAgent>("start",{input:{name,role:"main",cwd:release,release,args,threadConfig:{model:"gpt-6.1-sol",approvalsReviewer:"user",config:{"features.default_mode_request_user_input":false},developerInstructions:"あなたはDona mainです。ユーザーへの質問はSlack MCPで元threadへ投稿し、Event Resultを公開してください。回答は次のSlack eventとして届きます。native request_user_inputは使用しません。workerからの質問はget_task_questions/answer_task_questionで処理し、分かることは親として回答してください。"}}});
   await this.call("prompt",{name,key:`startup:${agent.generation}`,text:"起動確認です。外部操作、ファイル変更、プロセス操作は行わず、READYとだけ返してください。"});
   const deadline=Date.now()+this.policy.timeouts.agent_start_ms;
   let observation=await this.status(release);
   while(observation.status==="working"&&Date.now()<deadline){await delay(100);observation=await this.status(release);}
   const finished=await this.call<RuntimeAgent>("status",{name});
   if(finished.state!=="idle"||agent.generation===previous||!observation.exists||!observation.interactive_ready||!observation.matches_release||observation.status!=="idle")throw Error();
   return {outcome:"started",observation,error_code:null};
  }catch{return sent?{outcome:"accepted_unknown",observation:await this.status(release),error_code:"main_agent_start_unknown"}:{outcome:"rejected",observation:absent("main_agent_start_validation_failed"),error_code:"main_agent_start_validation_failed"};}
 }
}
