import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operatorStackFixture} from './operator-stack-fixture.js';
import {operatorRequest} from '../src/dashboard/operator-api.js';
test('実BFFのstale cancelは確定拒否となり、次のrequestで操作できる',async()=>{
 const f=await operatorStackFixture();try{
  const create=await f.request('/api/tasks',{cookie:f.cookie,csrf:f.csrf,body:{request_id:'create',objective:'確認',workspace:{kind:'scratch'}}}),task=create.body.task;
  const stale={request_id:'cancel_stale',attempt_id:task.current_attempt_id,revision:task.revision+1};
  const result=await f.request(`/api/tasks/${task.task_id}/cancel`,{cookie:f.cookie,csrf:f.csrf,body:stale});
  assert.equal(result.status,409);assert.deepEqual(result.body,{rejection:{request_id:'cancel_stale',operation:'cancel',code:'conflict',not_committed:true}});
  assert.equal((await f.request('/api/commands/cancel_stale?operation=cancel',{cookie:f.cookie})).body.receipt,null);
  const next=await f.request(`/api/tasks/${task.task_id}/cancel`,{cookie:f.cookie,csrf:f.csrf,body:{...stale,request_id:'cancel_current',revision:task.revision}});
  assert.equal(next.status,200);assert.equal(next.body.receipt.operation,'cancel');
  const invalid=await f.request('/api/tasks',{cookie:f.cookie,csrf:f.csrf,body:{request_id:'invalid',objective:'',workspace:{kind:'scratch'}}});
  assert.equal(invalid.status,409);assert.equal(invalid.body.rejection.code,'invalid');
  // Conflicting reuse cannot claim that an already accepted request was absent.
  const replay=await f.request('/api/tasks',{cookie:f.cookie,csrf:f.csrf,body:{request_id:'create',objective:'別内容',workspace:{kind:'scratch'}}});
  assert.equal(replay.status,503);assert.equal(replay.body.rejection,undefined);
 }finally{await f.close();}
});
test('commit後wake失敗はunknownで、受付照合から成功を取得できる',async()=>{
 const f=await operatorStackFixture();try{
  const token=decodeURIComponent(f.cookie.split('=')[1]!);
  await assert.rejects(operatorRequest(f.db,'commands/create',{token,input:{request_id:'lost',objective:'確認',workspace:{kind:'scratch'}}},{...f.config,readQuestions:async()=>[],wake(){throw Error('after_commit');}}),/after_commit/);
  const receipt=await f.request('/api/commands/lost?operation=create',{cookie:f.cookie});assert.equal(receipt.status,200);assert.equal(receipt.body.receipt.request_id,'lost');
 }finally{await f.close();}
});
