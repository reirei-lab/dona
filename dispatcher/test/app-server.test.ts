import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {AppServerRpc} from "../src/app-server/rpc.js";
import {AppServerManager} from "../src/app-server/manager.js";
import {RuntimeStore} from "../src/app-server/store.js";

const fake=`import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{userAgent:'test'}});
if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:'thread-test'}}});
if(r.method==='turn/start'){
 send({method:'turn/started',params:{threadId:'thread-test',turn:{id:'turn-test'}}});
 send({id:r.id,result:{turn:{id:'turn-test'}}});
 send({id:'question-1',method:'item/tool/requestUserInput',params:{threadId:'thread-test',turnId:'turn-test',itemId:'item-test',questions:[{id:'choice',question:'どちら？',isSecret:false,options:null}]}});
}
if(r.id==='question-1'&&r.result){send({method:'serverRequest/resolved',params:{threadId:'thread-test',requestId:'question-1'}});send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});}
});`;
async function until(check:()=>boolean):Promise<void>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.fail("condition did not settle");}

test("App Serverの質問を永続化し、一度の回答で同じthreadを継続する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-test-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake);
 const store=new RuntimeStore(path.join(root,"runtime.db"));const manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try {
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  const response=await manager.prompt(agent.name,"event-1","質問してください");assert.deepEqual(response,{turnId:"turn-test"});
  await until(()=>store.questions(agent.name).length===1);
  const q=store.questions(agent.name)[0]!;assert.equal(q.thread_id,agent.thread_id);assert.equal(manager.status(agent.name)?.state,"waiting");
  const answers={choice:{answers:["A"]}};await manager.answer(agent.name,q.question_id,answers);
  await until(()=>store.question(q.question_id)?.state==="resolved");
  assert.equal((await manager.answer(agent.name,q.question_id,answers)).state,"resolved");
  await assert.rejects(manager.answer(agent.name,q.question_id,{choice:{answers:["B"]}}),/not_current/);
  assert.equal(store.agent(agent.name)?.thread_id,"thread-test");assert.equal(manager.status(agent.name)?.state,"idle");
  assert.deepEqual(await manager.prompt(agent.name,"event-1","質問してください"),response);
  await assert.rejects(manager.prompt(agent.name,"event-1","別指示"),/operation_conflict/);
  await manager.stop(agent.name,agent.generation);assert.equal(manager.status(agent.name)?.state,"stopped");
 } finally {const row=store.agent("worker-test");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("host再起動時に保存済みagentを稼働確認済みとみなさない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-recovery-"));const store=new RuntimeStore(path.join(root,"runtime.db"));
 try {
  store.put({name:"worker-test",generation:"generation",role:"worker",cwd:root,release:root,thread_id:"thread",turn_id:"turn",pid:1,process_start:"old",state:"working",request_hash:"hash",config_json:"{}",sequence:0});
  const manager=new AppServerManager(store,()=>{throw Error("must not spawn");});
  assert.equal(manager.status("worker-test")?.state,"unknown");
  await assert.rejects(manager.prompt("worker-test","new","continue"),/not_ready/);
  await assert.rejects(manager.stop("worker-test","wrong-generation"),/identity_changed/);
 } finally {store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("非同期質問はturn完了後も回答可能で、停止後の古い要求には回答しない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-async-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,fake.replace("if(r.id==='question-1'&&r.result)","if(r.method==='turn/start')send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});\nif(r.id==='question-1'&&r.result)"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try {
  let agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"event-async","質問");await until(()=>store.questions(agent.name).length===1&&store.agent(agent.name)?.turn_id===null);
  const question=store.questions(agent.name)[0]!;assert.equal(manager.status(agent.name)?.state,"waiting");
  await manager.answer(agent.name,question.question_id,{choice:{answers:["A"]}});await until(()=>store.question(question.question_id)?.state==="resolved");
  await manager.stop(agent.name,agent.generation);
  agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await assert.rejects(manager.prompt(agent.name,"event-async","質問"),/generation_changed/);
  await manager.prompt(agent.name,"event-new","新しい質問");await until(()=>store.questions(agent.name).length===1);
  const old=store.questions(agent.name)[0]!;await manager.stop(agent.name,agent.generation);
  await assert.rejects(manager.answer(agent.name,old.question_id,{choice:{answers:["A"]}}),/not_current/);
 }finally{const row=store.agent("worker-test");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("利用上限のreset時刻を保存し、要求を再送せず復旧理由を照合する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-capacity-")),script=path.join(root,"fake.mjs");
 const reset=Math.ceil(Date.now()/1000)+3600;
 await fs.writeFile(script,fake.replace("send({id:'question-1',method:",`send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100,resetsAt:${reset}}}}});\n send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}}});\n return;\n send({id:'question-1',method:`));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try {
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"capacity","実行");await until(()=>manager.status(agent.name)?.state==="interrupted");
  assert.deepEqual(manager.status(agent.name)?.recovery_hint,{reason:"capacity_wait",retry_after:new Date(reset*1000).toISOString()});
  assert.equal(store.questions(agent.name).length,0);
  assert.deepEqual(await manager.prompt(agent.name,"capacity","実行"),{turnId:"turn-test"});
  await manager.stop(agent.name,agent.generation);
 }finally{const row=store.agent("worker-test");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("承認は現在の要求に一度だけ返し、session全体へ拡張しない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-approval-")),script=path.join(root,"fake.mjs");
 const approval=fake.replace("method:'item/tool/requestUserInput'","method:'item/permissions/requestApproval'").replace("questions:[{id:'choice',question:'どちら？',isSecret:false,options:null}]","permissions:{network:{enabled:true},fileSystem:null}").replace("if(r.id==='question-1'&&r.result){","if(r.id==='question-1'&&r.result){if(r.result.scope!=='turn'||r.result.permissions.network.enabled!==true||'fileSystem' in r.result.permissions)process.exit(9);");
 await fs.writeFile(script,approval);
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"approval","実行");await until(()=>store.questions(agent.name).length===1);
  const q=store.questions(agent.name)[0]!;assert.equal(q.kind,"approval");
  await manager.approve(agent.name,q.question_id,true);await until(()=>store.question(q.question_id)?.state==="resolved");
  assert.equal((await manager.approve(agent.name,q.question_id,true)).state,"resolved");
  await assert.rejects(manager.approve(agent.name,q.question_id,false),/not_current/);
  await manager.stop(agent.name,agent.generation);
 }finally{const row=store.agent("worker-test");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("質問待ちで接続を失ったgenerationの要求を失効させる",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-disconnect-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake);
 const store=new RuntimeStore(path.join(root,"runtime.db"));let rpc:AppServerRpc;
 const manager=new AppServerManager(store,(_args,cwd)=>rpc=new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"question-disconnect","質問");await until(()=>store.questions(agent.name).length===1);
  const q=store.questions(agent.name)[0]!;rpc!.child.kill("SIGKILL");
  await until(()=>store.agent(agent.name)?.state==="unknown");
  assert.equal(store.question(q.question_id)?.state,"expired");assert.equal(store.questions(agent.name).length,0);
  await assert.rejects(manager.answer(agent.name,q.question_id,{choice:{answers:["A"]}}),/not_current/);
 }finally{if(rpc!.child.exitCode===null&&rpc!.child.signalCode===null)rpc!.child.kill("SIGKILL");store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("対話経路のないjobではnative質問を拒否してpending要求を作らない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-server-no-question-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,fake.replace("if(r.id==='question-1'&&r.result)","if(r.id==='question-1'&&r.error)send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});\nif(r.id==='question-1'&&r.result)"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{config:{"features.default_mode_request_user_input":false}}});
  await manager.prompt(agent.name,"no-question","質問");await until(()=>store.agent(agent.name)?.state==="idle");
  assert.equal(store.questions(agent.name).length,0);await manager.stop(agent.name,agent.generation);
 }finally{const row=store.agent("worker-test");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const disappeared of [false,true])test(`停止途中のhost再起動は${disappeared?"root消失後の子":"凍結済みrootと子"}を照合して終了する`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-stop-recovery-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));\n`+fake);
 const store=new RuntimeStore(path.join(root,"runtime.db"));let manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker-test",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  const child=Number(await fs.readFile(path.join(root,"child.pid"),"utf8"));
  const {identity}=await import("../src/app-server/process.js"),captured=identity(agent.pid!)!;
  store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopping')").run(agent.name,agent.generation,JSON.stringify([captured]));
  process.kill(agent.pid!,disappeared?"SIGKILL":"SIGSTOP");
  if(disappeared)await until(()=>!identity(agent.pid!));
  manager=new AppServerManager(store,()=>{throw Error("worker must not restart");});
  await manager.recover();assert.equal(manager.status(agent.name)?.state,"stopped");assert.ok(!identity(child)||identity(child)!.state.includes("Z"));
  // 旧実装でreceiptだけ確定したcrash状態も、agentの終端まで完遂する。
  store.change(agent.name,agent.generation,{state:"unknown"});
  manager=new AppServerManager(store,()=>{throw Error("worker must not restart");});await manager.recover();assert.equal(manager.status(agent.name)?.state,"stopped");
 }finally{const agent=store.agent("worker-test");if(agent&&agent.state!=="stopped")await manager.stop(agent.name,agent.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const stopped of [false,true])test(`mainの復旧intentを${stopped?"停止完了後":"host再起動後"}から再開する`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-main-recovery-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake);
 const store=new RuntimeStore(path.join(root,"runtime.db")),factory=(_args:string[],cwd:string)=>new AppServerRpc(process.execPath,[script],cwd);
 let manager=new AppServerManager(store,factory);
 try{
  const input={name:"dona-main",role:"main" as const,cwd:root,release:root,args:[],threadConfig:{}};
  const old=await manager.start(input);assert.equal(manager.status(old.name)?.startup_ready,false);
  if(stopped){await manager.stop(old.name,old.generation);store.db.prepare("INSERT INTO main_recoveries VALUES(?,?,?)").run(old.name,old.generation,JSON.stringify(input));}
  manager=new AppServerManager(store,factory);await manager.recover();
  const fresh=manager.status(old.name)!;assert.equal(fresh.state,"idle");assert.notEqual(fresh.generation,old.generation);assert.equal(fresh.startup_ready,false);
  const {identity}=await import("../src/app-server/process.js");assert.ok(!identity(old.pid!)||identity(old.pid!)!.state.includes("Z"));
  await manager.stop(fresh.name,fresh.generation);
  manager=new AppServerManager(store,()=>{throw Error("intentional stop must not restart");});await manager.recover();assert.equal(manager.status(old.name)?.state,"stopped");
 }finally{const agent=store.agent("dona-main");if(agent&&agent.state!=="stopped")await manager.stop(agent.name,agent.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const role of ["main","worker"] as const)for(const synchronous of [false,true])test(`${role}の${synchronous?"同期":"非同期"}spawn失敗を停止済みとして記録し同名で再起動できる`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-spawn-failure-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake);
 const store=new RuntimeStore(path.join(root,"runtime.db"));let fail=true;
 const manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(fail?(synchronous?"":path.join(root,"missing-codex")):process.execPath,[script],cwd));
 const input={name:"test",role,cwd:root,release:root,args:[],threadConfig:{}};
 try{
  await assert.rejects(manager.start(input),/runtime_spawn_failed/);
  const failed=manager.status(input.name)!;assert.equal(failed.state,"stopped");assert.equal(failed.pid,null);
  assert.equal((await manager.stop(failed.name,failed.generation)).state,"stopped");
  fail=false;const active=await manager.start(input);assert.notEqual(active.generation,failed.generation);assert.equal(active.state,"idle");
  await manager.stop(active.name,active.generation);
 }finally{const row=store.agent(input.name);if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("非同期質問の背後で失敗したturnは、回答後もinterruptedと利用上限hintを保持する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-question-capacity-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,fake.replace("if(r.id==='question-1'&&r.result)","if(r.method==='turn/start')send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}}});\nif(r.id==='question-1'&&r.result)"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker",role:"worker",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"capacity-question","質問");await until(()=>store.questions(agent.name).length===1&&store.agent(agent.name)?.turn_id===null);
  const q=store.questions(agent.name)[0]!;assert.equal(manager.status(agent.name)?.state,"waiting");
  await manager.answer(agent.name,q.question_id,{choice:{answers:["A"]}});await until(()=>store.question(q.question_id)?.state==="resolved");
  assert.equal(manager.status(agent.name)?.state,"interrupted");assert.equal(manager.status(agent.name)?.recovery_hint?.reason,"capacity_wait");
  await manager.stop(agent.name,agent.generation);
 }finally{const row=store.agent("worker");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("mainのready証拠はそのgenerationの応答完了後だけ成立する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-main-ready-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake.replace("if(r.id==='question-1'&&r.result)","if(r.id==='question-1'&&(r.result||r.error))"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 const input={name:"main",role:"main" as const,cwd:root,release:root,args:[],threadConfig:{}};
 try{
  const agent=await manager.start(input);assert.equal(manager.status(agent.name)?.startup_ready,false);
  await manager.prompt(agent.name,"startup","READY");await until(()=>manager.status(agent.name)?.startup_ready===true);
  await manager.stop(agent.name,agent.generation);const fresh=await manager.start(input);assert.notEqual(fresh.generation,agent.generation);assert.equal(manager.status(fresh.name)?.startup_ready,false);
  await manager.stop(fresh.name,fresh.generation);
 }finally{const row=store.agent(input.name);if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const cancelled of [false,true])test(`main復旧中のspawn失敗後も${cancelled?"明示停止を尊重する":"復旧intentを引継ぎ再生成する"}`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-main-recovery-spawn-")),script=path.join(root,"fake.mjs");await fs.writeFile(script,fake);
 const store=new RuntimeStore(path.join(root,"runtime.db")),factory=(_args:string[],cwd:string)=>new AppServerRpc(process.execPath,[script],cwd);
 let manager=new AppServerManager(store,factory);
 try{
  const input={name:"main",role:"main" as const,cwd:root,release:root,args:[],threadConfig:{}};
  const old=await manager.start(input);
  manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(path.join(root,"missing"),[],cwd));await manager.recover();
  const failed=manager.status(old.name)!;assert.equal(failed.state,"stopped");assert.notEqual(failed.generation,old.generation);
  assert.equal((store.db.prepare("SELECT generation FROM main_recoveries WHERE agent=?").get(old.name) as {generation:string}).generation,failed.generation);
  if(cancelled)await manager.stop(failed.name,failed.generation);
  manager=new AppServerManager(store,factory);await manager.recover();const fresh=manager.status(old.name)!;
  assert.equal(fresh.state,cancelled?"stopped":"idle");assert.equal(fresh.generation===failed.generation,cancelled);
  assert.equal(store.db.prepare("SELECT 1 FROM main_recoveries WHERE agent=?").get(old.name),undefined);
  await manager.stop(fresh.name,fresh.generation);
 }finally{const row=store.agent("main");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("対話経路のないworkerの承認要求をpendingへ取り残さない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-no-approval-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,fake.replace("method:'item/tool/requestUserInput'","method:'item/permissions/requestApproval'").replace("questions:[{id:'choice',question:'どちら？',isSecret:false,options:null}]","permissions:{network:{enabled:true}}").replace("if(r.id==='question-1'&&r.result)","if(r.id==='question-1'&&r.error)send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});\nif(r.id==='question-1'&&r.result)"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"worker",role:"worker",cwd:root,release:root,args:[],threadConfig:{config:{"features.default_mode_request_user_input":false}}});
  await manager.prompt(agent.name,"approval","実行");await until(()=>store.agent(agent.name)?.state==="idle");assert.equal(store.questions(agent.name).length,0);
  await manager.stop(agent.name,agent.generation);
 }finally{const row=store.agent("worker");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const method of ["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/permissions/requestApproval"])test(`mainの${method}はDona MCP許可と分離して拒否する`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-main-denied-")),script=path.join(root,"fake.mjs");
 await fs.writeFile(script,fake.replace("method:'item/tool/requestUserInput'",`method:'${method}'`).replace("if(r.id==='question-1'&&r.result){","if(r.id==='question-1'&&r.result)process.exit(9);\nif(r.id==='question-1'&&r.error){"));
 const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  const agent=await manager.start({name:"main",role:"main",cwd:root,release:root,args:[],threadConfig:{approvalsReviewer:"user"}});
  await manager.prompt(agent.name,"denied","OS承認");await until(()=>store.agent(agent.name)?.state==="idle");assert.equal(store.questions(agent.name).length,0);
 }finally{const row=store.agent("main");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("外部reply dynamic toolは実turnへ束縛しnative質問と分離する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-app-external-")),script=path.join(root,"fake.mjs");
 const tool=fake.replace("method:'item/tool/requestUserInput'","method:'item/tool/call'").replace("itemId:'item-test',questions:[{id:'choice',question:'どちら？',isSecret:false,options:null}]","callId:'call-external',namespace:null,tool:'dona_request_thread_reply',arguments:{operation_slot:'reply_one',text:'確認した本文'}");
 await fs.writeFile(script,tool);const store=new RuntimeStore(path.join(root,"runtime.db")),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  assert.throws(()=>manager.external.accept({} as never,{} as never),/runtime_external_unavailable/);
  manager.external.availability(true);
  const agent=await manager.start({name:"main-external",role:"main",cwd:root,release:root,args:[],threadConfig:{}});
  const eventId="evt_01m3e2ht7qs79vf480z5qefeat";
  await manager.prompt(agent.name,eventId,"承認を要求");await until(()=>manager.external.pending().length===1);
  const row=manager.externalRequests()[0]!;assert.equal(row.source_event_id,eventId);assert.equal(row.attempt_id,null);assert.equal(row.text,"確認した本文");assert.notEqual((store.db.prepare("SELECT text FROM external_tool_requests WHERE request_id=?").get(row.request_id) as {text:string}).text,row.text);assert.equal(store.questions(agent.name).length,0);
  manager.external.availability(false);
  assert.equal(manager.external.pending().length,1);
  assert.throws(()=>manager.external.accept({} as never,{} as never),/runtime_external_unavailable/);
  assert.equal(manager.status(agent.name)?.state,"waiting");manager.resolveExternal(agent.name,row.request_id,{request_id:"approval",state:"pending"});
  await until(()=>manager.status(agent.name)?.state==="idle");assert.equal(manager.external.get(row.request_id)?.text,"");
  assert.equal(manager.resolveExternal(agent.name,row.request_id,{request_id:"approval",state:"pending"}).state,"resolved");
  assert.throws(()=>manager.resolveExternal(agent.name,row.request_id,{request_id:"other",state:"pending"}),/conflict/);
 }finally{const row=store.agent("main-external");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("外部draftはmemoryだけに保持しRuntime再起動で失効する",async()=>{
 const {ExternalToolQueue}=await import("../src/app-server/external-tools.js"),root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-external-memory-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 try{const queue=new ExternalToolQueue(store);queue.availability(true);
  const row=queue.accept({name:"main",generation:"g",thread_id:"t",turn_id:"turn",role:"main",config_json:"{}"} as any,{id:1,method:"item/tool/call",params:{threadId:"t",turnId:"turn",callId:"call",tool:"dona_request_thread_reply",arguments:{operation_slot:"slot",text:"private draft"}}});
  assert.equal(queue.get(row.request_id)?.text,"private draft");const persisted=JSON.stringify(store.db.prepare("SELECT * FROM external_tool_requests").all());assert.ok(!persisted.includes("private draft"));
  const other=queue.accept({name:"main",generation:"g2",thread_id:"t2",turn_id:"turn2",role:"main",config_json:"{}"} as any,{id:2,method:"item/tool/call",params:{threadId:"t2",turnId:"turn2",callId:"call",tool:"dona_request_thread_reply",arguments:{operation_slot:"slot",text:"next draft"}}});
  queue.expireAgent("main","g");assert.equal(queue.get(row.request_id)?.state,"expired");assert.equal(queue.get(other.request_id)?.text,"next draft");
  queue.expireRestart();assert.equal(queue.get(other.request_id)?.state,"expired");assert.equal(queue.get(row.request_id)?.text,"");assert.equal(queue.get(row.request_id)?.state,"expired");assert.throws(()=>queue.resolve(row.request_id,{request_id:null,state:"pending"}),/expired/);
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

for(const [label,params]of [
 ['未知tool',{tool:'unknown_external_tool'}],
 ['typed余分field',{arguments:{operation_slot:'slot',text:'draft',owner_id:'forged'}}],
 ['本文上限超過',{arguments:{operation_slot:'slot',text:'x'.repeat(3001)}}],
 ['thread差替え',{threadId:'wrong-thread'}],
] as const)test(`実App Server request入口で${label}を拒否し要求を保存しない`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-external-wire-deny-')),script=path.join(root,'fake.mjs'),response=path.join(root,'response.json');
 const request={id:'question-1',method:'item/tool/call',params:{threadId:'thread-test',turnId:'turn-test',callId:'call',namespace:null,tool:'dona_request_thread_reply',arguments:{operation_slot:'slot',text:'draft'},...params}};
 const code=fake.replace("import readline from 'node:readline';","import readline from 'node:readline';import fs from 'node:fs';")
  .replace("send({id:'question-1',method:'item/tool/requestUserInput',params:{threadId:'thread-test',turnId:'turn-test',itemId:'item-test',questions:[{id:'choice',question:'どちら？',isSecret:false,options:null}]}});",`send(${JSON.stringify(request)});`)
  .replace("if(r.id==='question-1'&&r.result){",`if(r.id==='question-1'&&(r.result||r.error)){fs.writeFileSync(${JSON.stringify(response)},JSON.stringify(r));`);
 await fs.writeFile(script,code);const store=new RuntimeStore(path.join(root,'runtime.db')),manager=new AppServerManager(store,(_args,cwd)=>new AppServerRpc(process.execPath,[script],cwd));
 try{
  manager.external.availability(true);const agent=await manager.start({name:'main-denial',role:'main',cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,'evt_'+'0'.repeat(26),'request');await until(()=>manager.status(agent.name)?.state==='idle');
  const denied=JSON.parse(await fs.readFile(response,'utf8'));assert.ok(denied.error||denied.result?.success===false);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM external_tool_requests').pluck().get(),0);assert.deepEqual(store.questions(agent.name),[]);
 }finally{const row=store.agent('main-denial');if(row&&row.state!=='stopped')await manager.stop(row.name,row.generation);store.close();await fs.rm(root,{recursive:true,force:true});}
});

test("worker外部callは同じturn内でも発生時のoperationを保持し未確定steer中は拒否する",async()=>{
 const {ExternalToolQueue}=await import("../src/app-server/external-tools.js"),root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-external-provenance-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 try{const queue=new ExternalToolQueue(store);queue.availability(true);
  const agent={name:"worker",generation:"g",thread_id:"t",turn_id:"turn",role:"worker",config_json:JSON.stringify({attemptId:"job_fixture"})} as any;
  const message=(call:string)=>({id:call,method:"item/tool/call",params:{threadId:"t",turnId:"turn",callId:call,tool:"dona_request_thread_reply",arguments:{operation_slot:call,text:"draft"}}});
  assert.throws(()=>queue.accept(agent,message("missing")),/source_unavailable/);
  const receipt=JSON.stringify({generation:"g",threadId:"t",turnId:"turn"});
  store.db.prepare("INSERT INTO operations VALUES(?,?,'fixture','accepted',?)").run("worker","attempt:job_fixture",receipt);
  const old=queue.accept(agent,message("before"));assert.equal(old.operation_key,"attempt:job_fixture");
  store.db.prepare("INSERT INTO operations VALUES(?,?,'fixture','sending',NULL)").run("worker","steer:evt_fixture");
  assert.throws(()=>queue.accept(agent,message("during")),/source_unavailable/);
  store.db.prepare("UPDATE operations SET state='unknown' WHERE operation_key=?").run("steer:evt_fixture");
  assert.throws(()=>queue.accept(agent,message("unknown")),/source_unavailable/);
  store.db.prepare("UPDATE operations SET state='accepted',result_json=? WHERE operation_key=?").run(receipt,"steer:evt_fixture");
  const next=queue.accept(agent,message("after"));assert.equal(next.operation_key,"steer:evt_fixture");
  assert.equal(queue.source(queue.get(old.request_id)!).operation_key,"attempt:job_fixture");
  queue.expireRestart();assert.equal(queue.get(old.request_id)?.state,"expired");assert.equal(queue.get(next.request_id)?.state,"expired");
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
