import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {execFileSync} from "node:child_process";
import {test} from "node:test";
import {AppServerRpc} from "../src/app-server/rpc.js";
import {RuntimeStore} from "../src/app-server/store.js";
import {AppServerManager} from "../src/app-server/manager.js";
import {projectHistory} from "../src/app-server/observation.js";

test("観測projectionは機械promptを除外しcommand結果をtypedに返す",()=>{
 const result=projectHistory({thread:{id:"thread",turns:[{id:"turn",items:[{id:"user",type:"userMessage",content:[{text:"[DONA_JOB] secret"}]},{id:"tool",type:"commandExecution",command:"npm test",aggregatedOutput:"3 tests passed",status:"completed"},{id:"agent",type:"agentMessage",text:"進捗"}]}]}});
 assert.deepEqual(result.items,[{id:"tool",turn_id:"turn",kind:"tool_progress",tool_type:"commandExecution",status:"completed",command:"npm test",output:"3 tests passed"},{id:"agent",turn_id:"turn",kind:"assistant_message",text:"進捗"}]);
});

test("通知は1000件・24時間に制限しretentionと再起動gapを保持する",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-store-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 try {
  for(let i=0;i<1002;i++)store.observe("worker","g",{kind:"turn/started"});
  let result=store.observations("worker","g",0);assert.equal(result.events.length,1000);assert.equal(result.gap,true);assert.equal(result.cursor,1002);
  assert.equal(store.observations("worker","g",1002).gap,false);
  store.db.prepare("UPDATE observation_events SET observed_at='2000-01-01T00:00:00Z'").run();result=store.observations("worker","g",1001);assert.equal(result.events.length,0);assert.equal(result.gap,true);
  store.observe("worker","g",{kind:"gap"});assert.equal(store.observations("worker","g",1002).gap,true);
  store.cacheItem("worker","g",{id:"same",turn_id:"one",kind:"assistant_message",text:"A"});store.cacheItem("worker","g",{id:"same",turn_id:"two",kind:"assistant_message",text:"B"});assert.equal(store.cachedItems("worker","g").length,2);
  store.cacheItem("worker","other",{id:"same",turn_id:"one",kind:"assistant_message",text:"C"});assert.equal(store.cachedItems("worker","g").length,2);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

const codex=process.env.DONA_TEST_CODEX;
test("固定Codex 0.160.0でUnix WebSocketのinitialize・履歴・通知を隔離検証する",{skip:!codex},async()=>{
 assert.equal(execFileSync(codex!,["--version"],{encoding:"utf8"}).trim(),"codex-cli 0.160.0");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-smoke-"));fs.chmodSync(root,0o700);
 const home=path.join(root,"home");fs.mkdirSync(home,{mode:0o700});
 const api=http.createServer((_request,response)=>{response.writeHead(401);response.end('{"error":{"message":"isolated smoke"}}');});
 await new Promise<void>(r=>api.listen(0,"127.0.0.1",r));
 const port=(api.address() as {port:number}).port;
 const args=["-c",'model_provider="smoke"',"-c",'model_providers.smoke.name="smoke"',"-c",`model_providers.smoke.base_url="http://127.0.0.1:${port}/v1"`,"-c",'model_providers.smoke.wire_api="responses"'];
 const rpc=new AppServerRpc(codex!,args,root,{PATH:process.env.PATH,HOME:home,CODEX_HOME:home},{socketPath:path.join(root,"rpc.sock")});
 const notifications:string[]=[];rpc.on("notification",m=>notifications.push(m.method));
 try {
  await rpc.initialize();
  const started=await rpc.request("thread/start",{cwd:root,approvalPolicy:"never",sandbox:"read-only",experimentalRawEvents:false,persistExtendedHistory:true}) as {thread:{id:string}};
  const history=await rpc.request("thread/read",{threadId:started.thread.id,includeTurns:false}) as {thread:{id:string}};
  await rpc.request("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"隔離smoke"}]});
  for(let i=0;i<100&&!notifications.includes("turn/started");i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(notifications.includes("turn/started"));
  const turns=await rpc.request("thread/turns/list",{threadId:started.thread.id,limit:10,itemsView:"full"}) as {data:unknown[]};assert.ok(turns.data.length>0);assert.ok(projectHistory({thread:{id:started.thread.id,turns:turns.data}}).items.some(item=>item.kind==="user_message"&&item.text==="隔離smoke"));
  assert.equal(history.thread.id,started.thread.id);assert.ok(notifications.includes("thread/started"));
  const peer=new AppServerRpc(codex!,[],root,{...process.env,CODEX_HOME:home},{socketPath:path.join(root,"rpc.sock"),attachPid:rpc.child.pid!});
  try {await peer.initialize();const read=await peer.request("thread/read",{threadId:started.thread.id,includeTurns:false}) as {thread:{id:string}};assert.equal(read.thread.id,started.thread.id);}finally{peer.closeConnection();}
  assert.throws(()=>new AppServerRpc(codex!,[],root,process.env,{socketPath:path.join(root,"rpc.sock")}),/collision/);
 }finally{api.closeAllConnections();api.close();rpc.closeConnection();if(rpc.child.exitCode===null&&rpc.child.signalCode===null){process.kill(-rpc.child.pid!,"SIGKILL");await new Promise(r=>rpc.child.once("exit",r));}fs.rmSync(root,{recursive:true,force:true});}
});

const fakeUnix=`import http from 'node:http';import fs from 'node:fs';import {WebSocketServer} from ${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href)};
process.umask(0o077);
const socket=process.argv[process.argv.indexOf('--listen')+1].slice(7);const server=http.createServer();const ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{const r=JSON.parse(bytes);fs.appendFileSync('calls',r.method+'\\n');const send=value=>client.send(JSON.stringify(value));
 if(r.method==='initialize')send({id:r.id,result:{}});
 if(r.method==='thread/start')send({id:r.id,result:{thread:{id:'owned-thread'}}});
 if(r.method==='thread/read')send({id:r.id,result:{thread:{id:r.params.threadId,status:{type:'idle'}}}});
 if(r.method==='thread/turns/list')send({id:r.id,result:{data:[{id:'turn',items:[{id:'message',type:'agentMessage',text:'進捗'}]}],nextCursor:null}});
 if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'turn'}}});send({method:'turn/started',params:{threadId:'owned-thread',turn:{id:'turn'}}});send({method:'item/completed',params:{threadId:'owned-thread',turnId:'turn',item:{id:'finished',type:'agentMessage',text:'保存済み'}}});}
}));server.listen(socket,()=>fs.chmodSync(socket,0o600));`;

test("Unix接続再生成でprocessを増やさず閲覧はread APIだけを呼ぶ",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-observe-"));fs.chmodSync(root,0o700);
 const script=path.join(root,"fake.mjs");fs.writeFileSync(script,fakeUnix);
 const store=new RuntimeStore(path.join(root,"runtime.db"));let spawned=0;const all:AppServerRpc[]=[];
 const factory=(_args:string[],cwd:string,row?:import('../src/app-server/store.js').AgentRecord,attach?:boolean)=>{
  if(!attach)spawned++;
  const rpc=new AppServerRpc(process.execPath,[script],cwd,process.env,{socketPath:path.join(root,"rpc.sock"),...(attach?{attachPid:row!.pid!}:{})});all.push(rpc);return rpc;
 };
 let manager=new AppServerManager(store,factory,true);
 try {
  const agent=await manager.start({name:"worker",role:"worker",attemptId:"job-one",cwd:root,release:root,args:[],threadConfig:{}});
  await manager.prompt(agent.name,"one","test");
  fs.writeFileSync(path.join(root,"calls"),"");
  const snapshot=await manager.conversation("worker",agent.generation);
  assert.equal(snapshot.attempt_id,"job-one");assert.equal(snapshot.items[0]?.text,"進捗");assert.equal(snapshot.connected,true);
  assert.deepEqual(fs.readFileSync(path.join(root,"calls"),"utf8").trim().split('\n'),['thread/read','thread/turns/list']);
  await assert.rejects(manager.conversation("other",agent.generation),/not_current/);
  await assert.rejects(manager.conversation("worker","stale"),/not_current/);
  all[0]!.closeConnection();assert.equal(manager.status("worker")?.state,"unknown");
  manager=new AppServerManager(store,factory,true);await manager.recover();
  const fresh=await manager.conversation("worker",agent.generation);assert.equal(fresh.connected,true);assert.equal(fresh.gap,true);assert.equal(spawned,1);assert.equal(store.agent("worker")?.pid,agent.pid);
  assert.ok(!fs.readFileSync(path.join(root,"calls"),"utf8").includes("thread/resume"));
  fs.writeFileSync(path.join(root,"rpc.sock.identity"),JSON.stringify({target:"other",dev:0,ino:0}));
  const changed=new AppServerRpc(process.execPath,[script],root,process.env,{socketPath:path.join(root,"rpc.sock"),attachPid:agent.pid!});
  await assert.rejects(changed.initialize(),/identity_changed/);
  await manager.stop(agent.name,agent.generation);
  const stopped=await manager.conversation(agent.name,agent.generation);assert.equal(stopped.items[0]?.text,"保存済み");assert.equal(stopped.gap,true);assert.equal(stopped.truncated,true);
 }finally{for(const rpc of all)rpc.closeConnection();const row=store.agent("worker");if(row)await manager.stop(row.name,row.generation);store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("runtime host再起動後も同じworkerへ接続し内部read APIを提供する",async()=>{
 const {serveRuntime}=await import("../src/app-server/host.js"),{RuntimeClient}=await import("../src/app-server/client.js");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-host-"));fs.chmodSync(root,0o700);const script=path.join(root,"codex");fs.writeFileSync(script,'#!/usr/bin/env node\n'+fakeUnix,{mode:0o700});
 const config={socket:path.join(root,"control"),database:path.join(root,"runtime.db"),codex:script,buildSha:"test"};
 let host=await serveRuntime(config);const client=new RuntimeClient(config.socket);let agent:import('../src/app-server/store.js').AgentRecord|undefined;
 try{
  agent=await client.start({name:"worker",role:"worker",attemptId:"job-host",cwd:root,release:root,args:[],threadConfig:{}});
  assert.equal((await client.conversations()).items[0]?.attempt_id,"job-host");
  assert.equal((await client.conversationHistory(agent.name)).items[0]?.generation,agent.generation);
  assert.deepEqual((await client.conversationHistory("unregistered")).items,[]);
  assert.equal((await client.conversation(agent.name,agent.generation)).items[0]?.text,"進捗");
  await new Promise<void>((r,j)=>host.close(e=>e?j(e):r()));host=await serveRuntime(config);
  let snapshot=await client.conversation(agent.name,agent.generation);
  for(let i=0;i<100&&!snapshot.connected;i++){await new Promise(r=>setTimeout(r,20));snapshot=await client.conversation(agent.name,agent.generation);}
  assert.equal(snapshot.connected,true);assert.equal(snapshot.gap,true);assert.equal((await client.status(agent.name))?.pid,agent.pid);
  await assert.rejects(client.conversation(agent.name,"stale"),/not_current/);
 }finally{if(agent)await client.stop(agent.name,agent.generation);await new Promise<void>(r=>host.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}
});

test("未送信startupは停止確認後に再試行でき、曖昧なthread作成は再送しない",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-start-"));fs.chmodSync(root,0o700);const script=path.join(root,"fake.mjs");fs.writeFileSync(script,fakeUnix);
 const store=new RuntimeStore(path.join(root,"runtime.db"));let failInitialize=true,ambiguous=false,spawned=0;
 const manager=new AppServerManager(store,(_args,cwd,row)=>{
  spawned++;const rpc=new AppServerRpc(process.execPath,[script],cwd,process.env,{socketPath:path.join(root,row!.generation.slice(0,8))});
  if(failInitialize)rpc.initialize=async()=>{throw Error("handshake failed");};
  if(ambiguous){const original=rpc.request.bind(rpc);rpc.request=(method,params,timeout)=>method==='thread/start'?Promise.reject(new Error('response lost')):original(method,params,timeout);}
  return rpc;
 },true);
 const input={name:"worker",role:"worker" as const,cwd:root,release:root,args:[],threadConfig:{}};
 try {
  await assert.rejects(manager.start(input),/runtime_start_not_sent/);assert.equal(manager.status("worker")?.state,"stopped");assert.equal(manager.status("worker")?.startup_state,"not_sent");
  failInitialize=false;const started=await manager.start(input);assert.equal(started.state,"idle");await manager.stop(started.name,started.generation);
  ambiguous=true;store.change(started.name,started.generation,{thread_id:null});await assert.rejects(manager.start(input),/response lost/);assert.equal(manager.status("worker")?.startup_state,"sending");
  const count=spawned;await manager.recover();assert.equal(spawned,count);await assert.rejects(manager.start(input),/recovery_required/);
 }finally{const row=store.agent("worker");if(row&&row.state!=="stopped")await manager.stop(row.name,row.generation);manager.closeConnections();store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("全世代retention・cache受信順・長文の保持と通知byte上限を確認する",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-expiry-")),file=path.join(root,"runtime.db");let store=new RuntimeStore(file);
 try{
  store.observe("old","old-generation",{kind:"item/agentMessage/delta",text:"secret"});
  store.cacheItem("old","old-generation",{id:"old",turn_id:"turn",kind:"assistant_message",text:"secret"});
  store.db.prepare("UPDATE observation_events SET observed_at='2000-01-01T00:00:00Z'").run();store.db.prepare("UPDATE observation_items SET observed_at='2000-01-01T00:00:00Z'").run();store.close();store=new RuntimeStore(file);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM observation_events").get() as {n:number}).n,0);assert.equal(store.cachedItems("old","old-generation").length,0);assert.equal(store.observations("old","old-generation",0).gap,true);
  store.cacheItem("current","g",{id:"z",turn_id:"turn",kind:"tool_progress"});store.cacheItem("current","g",{id:"a",turn_id:"turn",kind:"assistant_message",text:"after"});store.db.prepare("UPDATE observation_items SET observed_at=?").run(new Date().toISOString());assert.deepEqual(store.cachedItems("current","g").map(x=>x.id),['z','a']);
  store.cacheItem("current","g",{id:"a",turn_id:"turn",kind:"assistant_message",text:"after complete"});
  store.cacheItem("current","g",{id:"z",turn_id:"turn",kind:"tool_progress",status:"completed",command:"npm test"});
  assert.deepEqual(store.cachedItems("current","g").map(x=>x.id),['z','a']);
  assert.equal(store.cachedItems("current","g")[0]!.status,'completed');

  const history=projectHistory({thread:{id:"t",turns:[{id:"turn",items:[{id:"long",type:"agentMessage",text:"x".repeat(9000)}]}]}});
  assert.equal(history.truncated,false);assert.equal(history.items[0]?.text,"x".repeat(9000));
  for(let i=0;i<1000;i++)store.observe("current","g",{kind:"item/agentMessage/delta",text:"x".repeat(512)});
  const bounded=store.observations("current","g",0);assert.ok(Buffer.byteLength(JSON.stringify(bounded.events))<265000);assert.equal(bounded.gap,true);assert.ok(bounded.cursor<1001);assert.ok(store.observations("current","g",bounded.cursor).events.length>0);
  store.db.prepare("UPDATE observation_events SET observed_at='2000-01-01T00:00:00Z'").run();const manager=new AppServerManager(store,()=>{throw Error('no spawn');});await manager.recover();assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM observation_events").get() as {n:number}).n,0);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("100件の会話一覧でprocess tableを一度だけ取得する",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dr-list-")),store=new RuntimeStore(path.join(root,"runtime.db"));let samples=0;
 try {
  const manager=new AppServerManager(store,()=>{throw Error('no spawn');},false,()=>{samples++;return [];});
  for(let i=0;i<100;i++)store.put({name:`worker-${i}`,generation:"g",role:"worker",cwd:root,release:root,thread_id:"t",turn_id:null,pid:2147483647,process_start:"gone",state:"unknown",request_hash:"h",config_json:"{}",sequence:0});
  assert.equal(manager.conversations().items.length,100);assert.equal(samples,1);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
