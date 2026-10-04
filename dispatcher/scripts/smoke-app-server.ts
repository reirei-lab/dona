/** 認証済みローカルCodexで質問→Dispatcher API回答→同一AttemptのResultを検証する。
 * npm run build後、dispatcherで node --import tsx scripts/smoke-app-server.ts を実行。
 * Slack/GitHubへのwriteは行わない。生成ファイルと停止証拠は一時ディレクトリへ保存する。
 */
import fs from "node:fs/promises";
import {tempConfig,eventEnvelope} from "../test/helpers.js";
import {serveRuntime} from "../src/app-server/host.js";
import {AppServerJobRuntime,runtimeSocket} from "../src/app-server/adapters.js";
import {RuntimeClient} from "../src/app-server/client.js";
import {DispatcherDatabase} from "../src/database.js";
import {DispatcherApi} from "../src/api.js";
import {DispatcherApiClient} from "../src/client.js";
import {JobSupervisor} from "../src/job-supervisor.js";
const {root,config}=await tempConfig();
Object.assign(config,{codexPath:process.env.DONA_SMOKE_CODEX??"/opt/homebrew/bin/codex",jobCommandTimeoutMs:30_000,agentWaitTimeoutMs:10_000,jobPromptTimeoutMs:30_000,queuePollMs:250});
const host=await serveRuntime({socket:runtimeSocket(config),database:root+"/runtime.sqlite3",codex:config.codexPath,buildSha:"smoke"});
const db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config,false,undefined,id=>!!db.tasks.forAttempt(id)),client=new RuntimeClient(runtimeSocket(config));
const log={debug(){},info(){},warn(message:string){console.log(message);},error(message:string){console.log(message);}};
const supervisor=new JobSupervisor(db,runtime,config,log,()=>{}),api=new DispatcherApi(db,{isRunning:()=>true,wake(){}},supervisor,config,log);
let succeeded=false;
try {
 await api.start();const apiClient=new DispatcherApiClient(config.socketPath);
 const source=db.enqueue(eventEnvelope("app-server-smoke")).row;
 const created=await apiClient.createTask({source_event_id:source.event_id,task_key:"smoke",workspace:{kind:"scratch"},objective:"これは実行管理の接続テストです。native request_user_inputで「テストの選択は？」というA/Bの質問を1件出してください。回答を待ち、Aが届いたら指定Resultをcompletedで公開してください。質問待ちをfailed/blocked Resultにしません。ソース変更、外部サービスへの操作、Slack/GitHubの利用は不要です。Result作成・検証だけにshellを使えます。"});
 const task=created.task as {task_id:string;current_attempt_id:string};db.sealJobGroup(source.event_id);supervisor.start();
 const deadline=Date.now()+240_000;let answered=false;
 while(Date.now()<deadline){
  const event=db.list().find(e=>e.event_type==="worker_question");
  if(event&&!answered){
   const data=await apiClient.getTaskQuestions(task.task_id,event.event_id) as {revision:number;questions:Array<{question_id:string;kind:string;state:string;request:{questions:Array<{id:string}>}}>};
   const q=data.questions.find(q=>q.kind==="question"&&q.state==="pending");
   if(q){await apiClient.controlTask(task.task_id,"answer",{source_event_id:event.event_id,revision:data.revision,question_id:q.question_id,answers:Object.fromEntries(q.request.questions.map(q=>[q.id,{answers:["A"]}]))});answered=true;console.log("Dispatcher API accepted the native question answer");}
  }
  const current=db.tasks.get(task.task_id)!;
  if(current.state==="completed"){if(!answered||current.current_attempt_id!==task.current_attempt_id)throw Error("smoke_attempt_changed");succeeded=true;break;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 console.log(JSON.stringify({succeeded,answered,task:db.tasks.get(task.task_id)?.state,attempts:db.tasks.get(task.task_id)?.attempt_number}));
 if(!succeeded)process.exitCode=1;
}finally {
 await supervisor.stop();await api.stop();
 const stops=[];
 for(const agent of await client.list()){try{const stopped=agent.state==="stopped"?agent:await client.stop(agent.name,agent.generation);stops.push({name:stopped.name,generation:stopped.generation,state:stopped.state});}catch{stops.push({name:agent.name,generation:agent.generation,state:"stop_unverified"});process.exitCode=1;}}
 await fs.writeFile(root+"/verification.json",JSON.stringify({succeeded,stops},null,2),{mode:0o600});
 console.log("Test stop evidence:",root);
 await new Promise<void>((resolve,reject)=>host.close(error=>error?reject(error):resolve()));db.close();
}
