import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn,type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {RuntimeStore,type AgentRecord} from "../src/app-server/store.js";
import {AppServerManager} from "../src/app-server/manager.js";
import {RuntimeClient} from "../src/app-server/client.js";
import {identity,type ProcessIdentity} from "../src/app-server/process.js";

function worker(name:string):AgentRecord {
  return {name,generation:"generation",role:"worker",cwd:"/private/canary",release:"/private/release",thread_id:"thread",turn_id:"turn",
    pid:123,process_start:"start",state:"working",request_hash:"secret",config_json:JSON.stringify({attemptId:`job-${name}`,args:["secret-token"]}),sequence:0};
}
const sample:ProcessIdentity={pid:123,parent:1,group:123,uid:process.getuid!(),start:"start",state:"S"};

test("inventoryはboundedなread-only診断で、停止済みや空pageでも更新許可を返さない",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dh-inventory-")),store=new RuntimeStore(path.join(root,"runtime.db"));let samples=0;
  const manager=new AppServerManager(store,()=>{throw Error("RPC must not be called");},false,()=>{samples++;return [sample];});
  try {
    for(let i=0;i<102;i++)store.put(worker(`worker-${String(i).padStart(3,"0")}`));
    store.put({...worker("main"),role:"main"});
    store.put({...worker("stopped"),state:"stopped"});
    store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopped')").run("stopped","generation","[]");
    const before=store.db.prepare("SELECT total_changes() AS count").get();
    const page=manager.workerHandoffInventory();
    assert.equal(page.items.length,100);assert.equal(page.items[0]!.state,"stopped");assert.equal(page.next,"worker-098");assert.equal(samples,1);
    assert.equal(page.activation_allowed,false);assert.equal(page.handoff_enabled,false);assert.equal(page.compatibility,"unverified");
    assert.ok(page.blockers.includes("isolated_result_grant_unverified"));assert.ok(page.items.every(row=>row.blockers.includes("same_turn_unverified")));
    const last=manager.workerHandoffInventory(page.next!);assert.equal(last.items.length,3);assert.equal(last.next,null);
    const empty=manager.workerHandoffInventory("zz");assert.equal(empty.items.length,0);assert.equal(empty.activation_allowed,false);
    assert.deepEqual(store.db.prepare("SELECT total_changes() AS count").get(),before);
    const serialized=JSON.stringify(page);for(const secret of ["/private/","secret-token","request_hash","config_json","process_start"])assert.ok(!serialized.includes(secret));
    assert.throws(()=>manager.workerHandoffInventory("../other"),/cursor_invalid/);
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("同一pageのDB snapshotはprocess採取中のgeneration更新と混ざらない",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dh-snapshot-")),file=path.join(root,"runtime.db"),store=new RuntimeStore(file),other=new RuntimeStore(file);
  const manager=new AppServerManager(store,()=>{throw Error("RPC must not be called");},false,()=>{
    other.db.prepare("UPDATE agents SET generation='replacement' WHERE name='worker'").run();return [sample];
  });
  try {
    store.put(worker("worker"));
    store.addQuestion({question_id:"q",agent:"worker",generation:"generation",thread_id:"thread",turn_id:"turn",rpc_id_json:"1",kind:"approval",payload_json:'{"secret":"private-question"}',state:"expired",answer_hash:null,created_at:new Date().toISOString()});
    const page=manager.workerHandoffInventory(),row=page.items[0]!;
    assert.equal(row.generation,"generation");assert.equal(row.request_state,"expired");assert.ok(row.blockers.includes("expired_request_authority"));
    assert.equal(store.agent("worker")!.generation,"replacement");assert.ok(!JSON.stringify(page).includes("private-question"));
  }finally{other.close();store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("process採取不能とPID再利用を不在・継続可能と扱わず、質問を変更しない",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dh-unknown-")),store=new RuntimeStore(path.join(root,"runtime.db"));let mode="unavailable";
  const manager=new AppServerManager(store,()=>{throw Error("RPC must not be called");},false,()=>{if(mode==="unavailable")throw Error("timeout");return [{...sample,start:"reused"}];});
  try {
    store.put({...worker("worker"),state:"waiting"});
    store.addQuestion({question_id:"q",agent:"worker",generation:"generation",thread_id:"thread",turn_id:"turn",rpc_id_json:"1",kind:"question",payload_json:"{}",state:"pending",answer_hash:null,created_at:new Date().toISOString()});
    let row=manager.workerHandoffInventory().items[0]!;assert.equal(row.process_binding,"unavailable");assert.equal(row.state,"unknown");
    assert.ok(row.blockers.includes("process_observation_unavailable"));assert.ok(row.blockers.includes("pending_request_unsupported"));
    mode="mismatch";row=manager.workerHandoffInventory().items[0]!;assert.equal(row.process_binding,"mismatch");assert.ok(row.blockers.includes("worker_identity_mismatch"));
    assert.equal(store.question("q")!.state,"pending");assert.equal(store.agent("worker")!.state,"waiting");
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

// 生存するfake Codexはhost kill後も同じUnix socketを使う。readはturnを再生成しない。
const fakeCodex=`import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {WebSocketServer} from ${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href)};
process.umask(0o077);fs.appendFileSync('spawns',process.pid+'\\n');
const socket=process.argv[process.argv.indexOf('--listen')+1].slice(7),thread='thread-'+path.basename(process.cwd());
const server=http.createServer(),ws=new WebSocketServer({server});
ws.on('connection',client=>client.on('message',bytes=>{const r=JSON.parse(bytes);fs.appendFileSync('calls',r.method+'\\n');const send=x=>client.send(JSON.stringify(x));
if(r.method==='initialize')send({id:r.id,result:{}});
if(r.method==='thread/start')send({id:r.id,result:{thread:{id:thread}}});
if(r.method==='thread/read')send({id:r.id,result:{thread:{id:thread,status:{type:'active'}}}});
if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'accepted-turn'}}});send({method:'turn/started',params:{threadId:thread,turn:{id:'accepted-turn'}}});}
}));server.listen(socket,()=>fs.chmodSync(socket,0o600));`;

test("別processのhost kill/restart後も2 workerをread-only観測し、same turn/grantの未証明で拒否を維持する",{timeout:45_000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dh-process-"));fs.chmodSync(root,0o700);
  const socket=path.join(root,"host.sock"),database=path.join(root,"runtime.db"),codex=path.join(root,"codex");
  fs.writeFileSync(codex,'#!/usr/bin/env node\n'+fakeCodex,{mode:0o700});
  const client=new RuntimeClient(socket,5000),hosts:ChildProcess[]=[],agents:AgentRecord[]=[];
  async function startHost(){
    const child=spawn(process.execPath,["--import","tsx",path.resolve("test/fixtures/worker-handoff-host.ts"),socket,database,codex],{stdio:["ignore","ignore","pipe","ipc"]});hosts.push(child);
    const ready=await Promise.race([once(child,"message",{signal:AbortSignal.timeout(10_000)}),once(child,"exit").then(()=>{throw Error("fixture_host_exit");})]);assert.deepEqual(ready[0],{ready:true});return child;
  }
  try {
    let host=await startHost();
    for(const name of ["one","two"]){const cwd=path.join(root,name);fs.mkdirSync(cwd,{mode:0o700});const agent=await client.start({name,role:"worker",attemptId:`job-${name}`,cwd,release:root,args:[],threadConfig:{}});agents.push(agent);await client.prompt(name,`prompt-${name}`,"fixture-only");}
    const store=new RuntimeStore(database);try{const row=store.agent("two")!;store.change(row.name,row.generation,{state:"waiting"});store.addQuestion({question_id:"q",agent:row.name,generation:row.generation,thread_id:row.thread_id!,turn_id:row.turn_id!,rpc_id_json:"1",kind:"approval",payload_json:'{"secret":"never-publish"}',state:"pending",answer_hash:null,created_at:new Date().toISOString()});}finally{store.close();}
    const initial=await client.workerHandoffInventory();assert.equal(initial.items.length,2);assert.equal(initial.items[0]!.process_binding,"matched");assert.ok(initial.items[1]!.blockers.includes("waiting_unsupported"));
    for(const name of ["one","two"])fs.writeFileSync(path.join(root,name,"calls"),"");
    const exited=once(host,"exit");host.kill("SIGKILL");await exited;host=await startHost();
    // 接続確立を観測してからsnapshotを取る。固定sleepでrace順序を推測しない。
    let page=await client.workerHandoffInventory();const until=Date.now()+10_000;
    while(!page.items.every(row=>row.connected)&&Date.now()<until){await new Promise(r=>setTimeout(r,20));page=await client.workerHandoffInventory();}
    assert.ok(page.items.every(row=>row.connected));assert.equal(page.activation_allowed,false);
    for(const agent of agents){const row=page.items.find(row=>row.name===agent.name)!;assert.equal(row.generation,agent.generation);assert.equal(row.thread_id,agent.thread_id);assert.equal(row.turn_id,"accepted-turn");assert.equal(row.state,"unknown");assert.ok(row.blockers.includes("same_turn_unverified"));
      const current=await client.status(agent.name);assert.equal(current!.pid,agent.pid);assert.equal(current!.process_start,agent.process_start);
      const calls=fs.readFileSync(path.join(root,agent.name,"calls"),"utf8").trim().split('\n');assert.deepEqual(calls,['initialize','initialized','thread/read']);assert.equal(fs.readFileSync(path.join(root,agent.name,"spawns"),"utf8").trim().split('\n').length,1);
    }
    assert.ok(page.items[1]!.blockers.includes("expired_request_authority"));assert.ok(!JSON.stringify(page).includes("never-publish"));
    await assert.rejects(client.call("workerHandoffInventory",{protocol:2}),/protocol_unsupported/);
    await assert.rejects(client.workerHandoffInventory("../other"),/cursor_invalid/);
    assert.equal((await client.call<{activation_allowed:boolean}>("workerHandoffInventory",{protocol:1,enabled:true})).activation_allowed,false);
  }finally{
    for(const agent of agents){try{await client.stop(agent.name,agent.generation);}catch{if(agent.pid&&identity(agent.pid)?.start===agent.process_start)process.kill(-agent.pid,"SIGKILL");}}
    for(const child of hosts)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill("SIGKILL");await exited;}
    const socketDirectory=path.join(os.tmpdir(),`dr-${process.getuid?.()}-${createHash("sha256").update(path.resolve(database)).digest("hex").slice(0,12)}`);
    fs.rmSync(socketDirectory,{recursive:true,force:true});
    fs.rmSync(root,{recursive:true,force:true});
  }
});
