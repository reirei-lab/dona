import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {ExternalToolQueue} from '../src/app-server/external-tools.js';
import {RuntimeStore,type AgentRecord} from '../src/app-server/store.js';
import type {RpcMessage} from '../src/app-server/rpc.js';
const agent={name:'worker',generation:'generation',thread_id:'thread',turn_id:'turn',role:'worker',config_json:JSON.stringify({attemptId:'job_saved'})} as AgentRecord;
const input=()=>({id:'rpc',method:'item/tool/call',params:{tool:'dona_request_thread_reply',namespace:null,callId:'call',threadId:'thread',turnId:'turn',arguments:{operation_slot:'slot',text:'exact draft'}}});
const invalid:Array<[string,(m:any)=>void]>=[
 ['未知tool',m=>m.params.tool='slack.post_message'],['未知namespace',m=>m.params.namespace='slack'],
 ['本文上限超過',m=>m.params.arguments.text='x'.repeat(3001)],['slot上限超過',m=>m.params.arguments.operation_slot='x'.repeat(129)],
 ['空本文',m=>m.params.arguments.text=''],['空call',m=>m.params.callId=''],['call上限超過',m=>m.params.callId='x'.repeat(129)],
 ['RPC ID欠落',m=>delete m.id],['thread差替え',m=>m.params.threadId='other'],['turn差替え',m=>m.params.turnId='other'],
 ...['owner_id','workspace_id','channel_id','role','attempt_id','source_event_id','schema_version'].map(field=>[`${field}追加`,(m:any)=>m.params.arguments[field]='forged'] as [string,(m:any)=>void]),
];
for(const [name,alter]of invalid)test(`外部tool入口は${name}を保存前に拒否する`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-external-admission-')),store=new RuntimeStore(path.join(root,'runtime.db'));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new ExternalToolQueue(store);queue.availability(true);
 store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(agent.name,'job_saved','hash','accepted',JSON.stringify({generation:agent.generation,threadId:agent.thread_id,turnId:agent.turn_id}));
 const message=input();alter(message);
 assert.throws(()=>queue.accept(agent,message as RpcMessage));assert.equal(store.db.prepare('SELECT COUNT(*) FROM external_tool_requests').pluck().get(),0);assert.deepEqual(queue.pending(),[]);assert.equal(queue.waiting(agent.name),false);
});
test('外部toolのworker identityはhost設定から取り、callerのRPC metadataをauthorityにしない',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-external-authority-')),store=new RuntimeStore(path.join(root,'runtime.db'));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new ExternalToolQueue(store);queue.availability(true);
 for(const config of [{},{attemptId:'job_saved',threadConfig:{config:{'features.default_mode_request_user_input':false}}}])assert.throws(()=>queue.accept({...agent,config_json:JSON.stringify(config)},input()),/runtime_external_scope_invalid/);
 store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(agent.name,'job_saved','hash','accepted',JSON.stringify({generation:agent.generation,threadId:agent.thread_id,turnId:agent.turn_id}));
 const message=input();Object.assign(message.params,{role:'main',attemptId:'job_forged',source_event_id:'evt_forged'});
 const row=queue.accept(agent,message);assert.equal(row.role,'worker');assert.equal(row.attempt_id,'job_saved');assert.equal(row.source_event_id,null);assert.equal(row.generation,agent.generation);
 assert.equal(queue.accept(agent,message).request_id,row.request_id);
 assert.throws(()=>queue.accept(agent,{...message,params:{...message.params,arguments:{operation_slot:'slot',text:'changed'}}}),/runtime_external_conflict/);
 assert.equal(store.db.prepare('SELECT COUNT(*) FROM external_tool_requests').pluck().get(),1);
});

test('mainのsourceは受理済みexact generation/thread/turnの一意eventだけから導出する',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-external-source-')),store=new RuntimeStore(path.join(root,'runtime.db'));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const queue=new ExternalToolQueue(store);queue.availability(true);const row=queue.accept({...agent,role:'main',config_json:'{}'},input());
 const event='evt_'+'0'.repeat(26),binding={generation:agent.generation,threadId:agent.thread_id,turnId:agent.turn_id};
 const put=(key:string,state:string,value:unknown)=>store.db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?,?,?)').run(agent.name,key,'hash',state,JSON.stringify(value));
 assert.throws(()=>queue.source(row),/source_unavailable/);
 for(const value of [{...binding,generation:'other'},{...binding,threadId:'other'},{...binding,turnId:'other'}]){put(event,'accepted',value);assert.throws(()=>queue.source(row),/source_unavailable/);}
 put(event,'sending',binding);assert.throws(()=>queue.source(row),/source_unavailable/);
 put(event,'accepted',binding);assert.equal(queue.source(row).source_event_id,event);
 put('evt_'+'1'.repeat(26),'accepted',binding);assert.throws(()=>queue.source(row),/source_unavailable/);
 store.db.prepare('DELETE FROM operations').run();put('not_event','accepted',binding);assert.throws(()=>queue.source(row),/source_unavailable/);
});
