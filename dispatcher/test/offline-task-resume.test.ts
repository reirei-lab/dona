import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {DispatcherDatabase} from '../src/database.js';
import {taskRequestSchema} from '../src/task-execution.js';
import {RuntimeStore} from '../src/app-server/store.js';
import {AppServerManager} from '../src/app-server/manager.js';
import {AppServerJobRuntime} from '../src/app-server/adapters.js';
import type {StartAgent} from '../src/app-server/manager.js';
import {AppServerRpc,RpcFailure,RpcSpawnFailure} from '../src/app-server/rpc.js';
import Database from 'better-sqlite3';
import {JobSupervisor} from '../src/job-supervisor.js';
import type {JobAgentRuntime} from '../src/job-runtime.js';
import {migrateStoppedRuntime} from '../src/app-server/migration.js';
import {buildJobPrompt} from '../src/job-prompt.js';
import {eventEnvelope,tempConfig} from './helpers.js';

async function fixture(){
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtimeFile=path.join(root,'runtime.db');
 const runtime=new RuntimeStore(runtimeFile);new AppServerManager(runtime,()=>{throw Error('must not spawn');});
 const event=db.enqueue(eventEnvelope('resume')).row;
 const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'implementation',objective:'既存PRを確認して実装を続ける',workspace:{kind:'scratch'},policy:{max_attempts:3,retry_delay_ms:1000}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
 const job=db.getJob(task.current_attempt_id)!;await fs.mkdir(job.workspace_path,{recursive:true});
 db.beginJobPreparation(job.job_id,new Date(job.available_at));db.setJobRuntime(job.job_id,job.agent_name,job.agent_name,JSON.stringify(['original-generation','saved-thread']));db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
 runtime.put({name:job.agent_name,generation:'original-generation',role:'worker',cwd:job.workspace_path,release:root,thread_id:'saved-thread',turn_id:'old-turn',pid:2147483646,process_start:'gone',state:'working',request_hash:'old',config_json:JSON.stringify({attemptId:job.job_id}),sequence:0});
 const receipt={processes:[],launch_agents:['dev.dona.dispatcher','dev.dona.updater','dev.dona.slack-adapter'],herdr_session:'dona',verified_at:new Date().toISOString()};
 const migrate=()=>migrateStoppedRuntime(config.databasePath,runtimeFile,receipt,root,{runId:'update-1',resultDir:config.jobResultsDir});
 return {root,config,db,runtime,event,task,job,migrate,async close(){runtime.close();db.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('停止更新で同じTaskの新Attemptと同じ会話を復元し、再実行でも重複しない',async()=>{
 const f=await fixture();let manager:AppServerManager|undefined;
 try{
  f.migrate();const current=f.db.tasks.get(f.task.task_id)!,next=f.db.getJob(current.current_attempt_id)!;
  assert.notEqual(next.job_id,f.job.job_id);assert.equal(current.attempt_number,2);assert.equal(current.max_attempts,3);assert.equal(next.workspace_path,f.job.workspace_path);assert.notEqual(next.result_path,f.job.result_path);
  assert.equal(f.db.tasks.mayNotify(f.db.getJob(f.job.job_id)!),false);assert.throws(()=>f.db.tasks.assertCurrent(f.job),/superseded/);
  assert.equal(f.db.getJob(f.job.job_id)!.status,'cancelled');assert.equal(f.db.tasks.attempts(f.task.task_id)[0]!.outcome,'interrupted');
  const resumed=JSON.parse(next.workspace_json)._dona_resume;assert.equal(resumed.source.thread_id,'saved-thread');assert.match(buildJobPrompt(next),/旧結果保存先へ書かない/);
  f.migrate();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,next.job_id);
  const script=path.join(f.root,'fake.mjs'),calls=path.join(f.root,'calls');
  await fs.writeFile(script,`#!${process.execPath}
if(process.argv.includes('mcp')){process.stdout.write('[]');process.exit(0);}
import readline from 'node:readline';import fs from 'node:fs';const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='thread/resume')send({id:r.id,result:{thread:{id:r.params.threadId}}});else if(r.method==='turn/start')send({id:r.id,result:{turn:{id:'new-turn'}}});});`,{mode:0o700});
  manager=new AppServerManager(f.runtime,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
  f.config.codexPath=script;f.config.jobCommandTimeoutMs=5000;const adapter=new AppServerJobRuntime(f.config,false,undefined,()=>true);let input!:StartAgent;
  adapter.client.start=async request=>{input=request;return manager!.start(request);};
  const prepared=await adapter.prepare(next);const agent=f.runtime.agent(next.agent_name)!;assert.equal(agent.thread_id,'saved-thread');assert.equal(prepared.herdrAgentSessionId,JSON.stringify([agent.generation,'saved-thread']));
  await manager.prompt(agent.name,'new-attempt',buildJobPrompt(next));
  const recorded=(await fs.readFile(calls,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(recorded.filter(c=>c.method==='thread/resume').length,1);assert.equal(recorded.filter(c=>c.method==='thread/start').length,0);
  assert.equal(recorded.filter(c=>c.method==='turn/start').length,1);assert.match(recorded.find(c=>c.method==='turn/start').params.input[0].text,new RegExp(next.job_id));
  await assert.rejects(manager.start({...input,name:'wrong-generation',resumeFrom:{...resumed.source,generation:'wrong'}}),/source_unverified/);
  await assert.rejects(manager.start({...input,name:'duplicate',attemptId:'duplicate'}),/already_claimed/);
  assert.equal((await manager.start(input)).generation,agent.generation);
 }finally{if(manager)for(const agent of f.runtime.agents())if(agent.state!=='stopped')await manager.stop(agent.name,agent.generation);await f.close();}
});

for(const kind of ['approval','result','paused','budget','identity','checkpoint'] as const)test(`停止更新は${kind}を自動再実行へ変換しない`,async()=>{
 const f=await fixture();try{
  if(kind==='checkpoint'){await fs.mkdir(path.dirname(f.job.result_path),{recursive:true});await fs.writeFile(path.join(path.dirname(f.job.result_path),'checkpoint.json'),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:1,summary:'結果確認待ち',remaining:[],artifacts:[],unresolved_operations:['pushの受理不明'],waiting:'external_effect_unknown'}));}
  if(kind==='approval')f.runtime.addQuestion({question_id:'approval',agent:f.job.agent_name,generation:'original-generation',thread_id:'saved-thread',turn_id:'old-turn',rpc_id_json:'1',kind:'approval',payload_json:'{}',state:'pending',answer_hash:null,created_at:new Date().toISOString()});
  if(kind==='result'){await fs.mkdir(path.dirname(f.job.result_path),{recursive:true});await fs.writeFile(f.job.result_path,'{"summary":"停止直前の成果"}');}
  if(kind==='paused')f.db.tasks.control(f.task.task_id,f.event.event_id,f.db.tasks.get(f.task.task_id)!.revision,'pause');
  if(kind==='budget')f.db.tasks.offlineResumes['sql'].prepare('UPDATE tasks SET max_attempts=1 WHERE task_id=?').run(f.task.task_id);
  if(kind==='identity')f.runtime.put({...f.runtime.agent(f.job.agent_name)!,cwd:f.root});
  f.migrate();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);
  if(kind==='approval'){assert.equal(f.runtime.question('approval')!.state,'expired');assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,'human_input');}
  if(kind==='result')assert.equal(await fs.readFile(f.job.result_path,'utf8'),'{"summary":"停止直前の成果"}');
  f.migrate();assert.equal(f.db.tasks.attempts(f.task.task_id).length,1);
 }finally{await f.close();}
});

function supervisor(f:Awaited<ReturnType<typeof fixture>>) {
 const stopped={state:'stopped' as const,reason:'verified',observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
 const runtime:JobAgentRuntime={async prepare(){throw Error('unexpected');},async prompt(){throw Error('stopped worker must not receive steer');},async get(){throw Error('unexpected');},async wait(){throw Error('unexpected');},async cancel(){throw Error('unexpected');},async observeWorker(){return stopped;},async retireWorker(){throw Error('already stopped');},async workerRetired(){return f.runtime.agent(f.job.agent_name)?.state==='stopped';}};
 return new JobSupervisor(f.db,runtime,f.config,{debug(){},info(){},warn(){},error(){}},()=>{});
}
function due(f:Awaited<ReturnType<typeof fixture>>){const task=f.db.tasks.get(f.task.task_id)!;f.db.tasks.wait(task,task.wait_reason??'observation_unknown',-1);}

test('停止更新のcapacity待機は保存した期限後に自動再開する',async()=>{
 const f=await fixture();try{
  const deadline=new Date(Date.now()+60_000).toISOString();
  f.runtime.db.prepare('INSERT INTO recovery_hints VALUES(?,?,?,?)').run(f.job.agent_name,'original-generation','capacity_wait',deadline);
  f.migrate();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);assert.equal(f.db.tasks.offlineResumes.saved(f.job.job_id)!.retry_after,deadline);
  due(f);await supervisor(f).reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);
  const sql=new Database(f.config.databasePath);sql.prepare("UPDATE offline_task_resumes SET retry_after=?").run(new Date(Date.now()-1).toISOString());sql.close();
  due(f);await supervisor(f).reconcileTasks();assert.notEqual(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);
 }finally{await f.close();}
});

for(const interrupted of [false,true])test(`停止更新のhuman_input回答を停止workerへ再送せず後継へ引き継ぐ interrupted=${interrupted}`,async()=>{
 const f=await fixture();try{
  await fs.mkdir(path.dirname(f.job.result_path),{recursive:true});await fs.writeFile(path.join(path.dirname(f.job.result_path),'checkpoint.json'),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:1,summary:'質問待ち',remaining:[],artifacts:[],unresolved_operations:[],waiting:'human_input'}));
  f.migrate();const task=f.db.tasks.get(f.task.task_id)!;assert.equal(task.wait_reason,'human_input');
  f.db.tasks.prepareSteer(task.task_id,f.event.event_id,task.revision,'回答を保存して続行');
  const s=supervisor(f);if(!interrupted)await s.steer(f.job.job_id,f.event.event_id,'回答を保存して続行');else {due(f);await s.reconcileTasks();}
  due(f);await s.reconcileTasks();const next=f.db.tasks.get(task.task_id)!;
  assert.notEqual(next.current_attempt_id,f.job.job_id);assert.match(f.db.getJob(next.current_attempt_id)!.objective,/回答を保存して続行/);
  assert.equal(f.db.getJob(f.job.job_id)!.steer_state,null);
 }finally{await f.close();}
});

test('cold移行の未登録verifierを恒久保留にせず起動後のreceipt検証で再開する',async()=>{
 const f=await fixture();try{
  const sql=new Database(f.config.databasePath);sql.exec('CREATE TABLE task_external_approval_checkpoints(attempt_id TEXT,runtime_request_id TEXT,request_id TEXT,state TEXT)');sql.prepare('INSERT INTO task_external_approval_checkpoints VALUES(?,?,?,?)').run(f.job.job_id,'runtime-request','request','succeeded');sql.close();
  f.migrate();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);assert.equal(f.db.tasks.offlineResumes.saved(f.job.job_id)!.state,'pending');
  let verified=false;f.db.tasks.registerExternalApprovalRecoveryVerifier(input=>{assert.equal(input.attempt_id,f.job.job_id);verified=true;return {effect:'accepted',request_id:input.request_id,attempt_id:input.attempt_id,receipt_ref:'verified-receipt'};});
  due(f);await supervisor(f).reconcileTasks();const task=f.db.tasks.get(f.task.task_id)!;
  assert.equal(verified,true);assert.notEqual(task.current_attempt_id,f.job.job_id);assert.match(f.db.getJob(task.current_attempt_id)!.objective,/verified-receipt/);
 }finally{await f.close();}
});

for(const failure of ['spawn','initialize','rejected','unknown'] as const)test(`resumeの${failure}は受理状態に従ってclaimを保持する`,async()=>{
 const f=await fixture();let manager:AppServerManager|undefined;try{
  f.migrate();const job=f.db.getJob(f.db.tasks.get(f.task.task_id)!.current_attempt_id)!,source=JSON.parse(job.workspace_json)._dona_resume.source;
  const script=path.join(f.root,'failure.mjs');await fs.writeFile(script,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result=r.method==='thread/resume'?{thread:{id:r.params.threadId}}:{};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`);
  let failing=true;manager=new AppServerManager(f.runtime,(_args,cwd)=>{
   if(failing&&failure==='spawn')throw new RpcSpawnFailure('failed');
   const rpc=new AppServerRpc(process.execPath,[script],cwd),request=rpc.request.bind(rpc);
   rpc.request=async(method,...args)=>{if(failing&&((failure==='initialize'&&method==='initialize')||(failure!=='initialize'&&method==='thread/resume')))throw new RpcFailure('test',failure==='unknown'?'unknown':failure==='rejected'?'rejected':'not_sent');return request(method,...args);};return rpc;
  });
  const input:StartAgent={name:job.agent_name,attemptId:job.job_id,role:'worker',cwd:f.job.workspace_path,release:f.root,args:[],threadConfig:{},resumeFrom:source};
  await assert.rejects(manager.start(input));failing=false;
  if(failure==='unknown')await assert.rejects(manager.start({...input,name:'retry',attemptId:'retry'}),/already_claimed/);
  else assert.equal((await manager.start({...input,name:'retry',attemptId:'retry'})).thread_id,'saved-thread');
 }finally{if(manager)for(const agent of f.runtime.agents())if(agent.state!=='stopped')await manager.stop(agent.name,agent.generation);await f.close();}
});

for(const unresolved of [false,true])test(`停止前の未確定steerはreceiptを残し既知の未解決操作を照合する unresolved=${unresolved}`,async()=>{
 const f=await fixture();try{
  f.db.tasks.prepareSteer(f.task.task_id,f.event.event_id,f.db.tasks.get(f.task.task_id)!.revision,'追加条件を引き継ぐ');f.db.beginJobSteer(f.job.job_id,f.event.event_id);
  if(unresolved){await fs.mkdir(path.dirname(f.job.result_path),{recursive:true});await fs.writeFile(path.join(path.dirname(f.job.result_path),'checkpoint.json'),JSON.stringify({schema_version:1,task_id:f.task.task_id,attempt_id:f.job.job_id,sequence:1,summary:'push結果未確認',remaining:[],artifacts:[],unresolved_operations:['push'],waiting:'external_effect_unknown'}));}
  f.migrate();const task=f.db.tasks.get(f.task.task_id)!;
  assert.equal(JSON.parse(f.db.tasks.offlineResumes.saved(f.job.job_id)!.steer_json!).state,'dispatching');
  if(unresolved){assert.equal(task.current_attempt_id,f.job.job_id);assert.equal(task.wait_reason,'external_effect_unknown');}
  else {assert.notEqual(task.current_attempt_id,f.job.job_id);assert.equal(task.steer_pending_event_id,null);const next=f.db.getJob(task.current_attempt_id)!;assert.match(next.objective,/追加条件を引き継ぐ/);assert.match(buildJobPrompt(next),/"prior_steer_acceptance":\s*"unknown"/);}
 }finally{await f.close();}
});

test('実際のexternal_approval待機もterminal receipt照合後に再開する',async()=>{
 const f=await fixture();try{
  const sql=new Database(f.config.databasePath);sql.exec('CREATE TABLE task_external_approval_checkpoints(attempt_id TEXT,runtime_request_id TEXT,request_id TEXT,state TEXT)');sql.prepare('INSERT INTO task_external_approval_checkpoints VALUES(?,?,?,?)').run(f.job.job_id,'runtime-request','request','pending');
  sql.prepare("UPDATE jobs SET status='blocked',last_error_code='runtime_external_approval_pending' WHERE job_id=?").run(f.job.job_id);sql.close();
  f.db.tasks.wait(f.db.tasks.get(f.task.task_id)!,'external_approval',0);
  f.runtime.put({...f.runtime.agent(f.job.agent_name)!,state:'waiting'});
  f.migrate();assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);assert.equal(f.db.tasks.offlineResumes.saved(f.job.job_id)!.state,'pending');
  due(f);await supervisor(f).reconcileTasks();assert.equal(f.db.tasks.get(f.task.task_id)!.wait_reason,'external_approval');
  const terminal=new Database(f.config.databasePath);terminal.prepare("UPDATE task_external_approval_checkpoints SET state='succeeded'").run();terminal.close();
  f.db.tasks.registerExternalApprovalRecoveryVerifier(input=>({effect:'accepted',request_id:input.request_id,attempt_id:input.attempt_id,receipt_ref:'receipt'}));
  due(f);await supervisor(f).reconcileTasks();assert.notEqual(f.db.tasks.get(f.task.task_id)!.current_attempt_id,f.job.job_id);
 }finally{await f.close();}
});

test('activation後の再停止は現在Attemptのスレッドを次Attemptへ保存する',async()=>{
 const f=await fixture();try{
  f.migrate();const current=f.db.tasks.get(f.task.task_id)!,job=f.db.getJob(current.current_attempt_id)!;
  f.db.beginJobPreparation(job.job_id,new Date(job.available_at));f.db.setJobRuntime(job.job_id,job.agent_name,job.agent_name,JSON.stringify(['second-generation','saved-thread']));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
  f.runtime.put({...f.runtime.agent(f.job.agent_name)!,name:job.agent_name,generation:'second-generation',state:'working',config_json:JSON.stringify({attemptId:job.job_id})});
  f.migrate();const latest=f.db.tasks.get(f.task.task_id)!,next=f.db.getJob(latest.current_attempt_id)!;
  assert.equal(latest.attempt_number,3);assert.equal(JSON.parse(next.workspace_json)._dona_resume.source.attempt_id,job.job_id);assert.equal(JSON.parse(next.workspace_json)._dona_resume.source.generation,'second-generation');assert.equal(JSON.parse(next.workspace_json)._dona_resume.source.thread_id,'saved-thread');
 }finally{await f.close();}
});
