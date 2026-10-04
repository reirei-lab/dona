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
