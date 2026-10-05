import assert from 'node:assert/strict';
import test from 'node:test';
import {taskRequestSchema} from '../dispatcher/src/task-execution.js';
import {authenticator} from '../dispatcher/test/webauthn-fixture.js';
import {eventEnvelope} from '../dispatcher/test/helpers.js';
import {operatorStackFixture as fixture} from '../dispatcher/test/operator-stack-fixture.js';

test('実BFFからの依頼はCSRF・未知fieldを拒否し、response喪失後はreceipt readだけで照合する',{timeout:20000},async()=>{const f=await fixture();try{
 const input={request_id:'create-one',objective:'HTTPから依頼',workspace:{kind:'scratch'}};
 for(const options of [{body:input},{body:input,csrf:'wrong'},{body:input,csrf:f.csrf,origin:'https://attacker.test'},{body:{...input,owner_id:'forged'},csrf:f.csrf},{raw:'{"invalid":',csrf:f.csrf},{body:{...input,workspace:{kind:'scratch',path:'/untrusted'}},csrf:f.csrf}]){const result=await f.request('/api/tasks',{cookie:f.cookie,...options});assert.notEqual(result.status,200);assert.equal(f.db.tasks.scanSnapshot().length,0);}
 await f.request('/api/tasks',{cookie:f.cookie,csrf:f.csrf,body:input,loseResponse:true});assert.equal(f.db.tasks.scanSnapshot().length,1);
 const accepted=await f.request('/api/commands/create-one?operation=create',{cookie:f.cookie});assert.equal(accepted.status,200);assert.equal(accepted.body.receipt.operation,'create');assert.doesNotMatch(JSON.stringify(accepted.body),/workspace_path|result_path|canonical_sha256/);
 const task=f.db.tasks.get(accepted.body.receipt.task_id)!;const cancel={request_id:'cancel-one',attempt_id:task.current_attempt_id,revision:task.revision};
 assert.notEqual((await f.request(`/api/tasks/${task.task_id}/cancel`,{cookie:f.cookie,csrf:f.csrf,body:{...cancel,task_id:'forged'}})).status,200);
 const result=await f.request(`/api/tasks/${task.task_id}/cancel`,{cookie:f.cookie,csrf:f.csrf,body:cancel});assert.equal(result.status,200);assert.equal(f.db.tasks.get(task.task_id)?.state,'cancelled');assert.equal(f.db.tasks.scanSnapshot().length,1);
}finally{await f.close();}});

test('実BFF質問回答をmainの正規APIからruntimeへ一度届け、runtime照会中のrevokeで開示しない',{timeout:20000},async()=>{const f=await fixture();try{
 const submitted=await f.request('/api/tasks',{cookie:f.cookie,csrf:f.csrf,body:{request_id:'question-task',objective:'質問する',workspace:{kind:'scratch'}}});assert.equal(submitted.status,200);const {task,job,q}=f.startQuestion(submitted.body.task.task_id,'question','human_question');
 const pending=await f.request(`/api/tasks/${task.task_id}/questions?kind=question`,{cookie:f.cookie});assert.equal(pending.status,200);assert.equal(pending.body.questions[0].question_id,q.question_id);
 const answers={scope:{answers:['状態を調査してください']}};const reply=await f.request(`/api/tasks/${task.task_id}/questions/${q.question_id}/reply`,{cookie:f.cookie,csrf:f.csrf,body:{request_id:'answer-one',attempt_id:job.job_id,revision:pending.body.revision,kind:'question',answers}});assert.equal(reply.status,200);assert.equal(f.writes.length,0);
 assert.equal((await f.request(`/v1/tasks/${task.task_id}/answer`,{dispatcher:true,body:{source_event_id:reply.body.receipt.event_id,revision:pending.body.revision,question_id:q.question_id,answers}})).status,200);assert.deepEqual(f.writes,[{action:'answer',id:q.question_id}]);
 let entered!:()=>void,release!:()=>void;const arrived=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);f.setReadGate(async()=>{entered();await gate;});
 const read=f.request(`/api/tasks/${task.task_id}/questions?kind=question`,{cookie:f.cookie});await arrived;await f.request('/revoke',{control:true,body:{device_id:f.session.body.device_id}});release();const denied=await read;assert.notEqual(denied.status,200);assert.doesNotMatch(JSON.stringify(denied.body),/状態を調査|human_question/);assert.equal(f.writes.length,1);
}finally{await f.close();}});

test('Slack Taskのnative要求へ実WebAuthn署名をBFF経由で渡し元ownerを保持する',{timeout:20000},async()=>{const f=await fixture();try{
 const event=f.db.enqueue(eventEnvelope('http-slack-approval')).row;const task=f.db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'slack-origin',objective:'Slackからの依頼',workspace:{kind:'scratch'}}),f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
 const {job,q}=f.startQuestion(task.task_id,'approval','slack_native');const before=f.db.tasks.assertOwner(task.task_id,event.event_id).source_event_id;
 const device=authenticator(),registration=await f.request('/api/credential/options',{cookie:f.cookie,csrf:f.csrf,body:{}});assert.equal(registration.status,200);
 const registered=await f.request('/api/credential/register',{cookie:f.cookie,csrf:f.csrf,body:{ceremony_id:registration.body.ceremony_id,response:device.register(registration.body.options.challenge)}});assert.equal(registered.status,200);
 const pending=await f.request(`/api/tasks/${task.task_id}/questions?kind=approval`,{cookie:f.cookie});assert.equal(pending.status,200);
 const input={request_id:'native-one',task_id:task.task_id,attempt_id:job.job_id,revision:pending.body.revision,question_id:q.question_id,kind:'approval',accepted:false};
 const options=await f.request('/api/native/options',{cookie:f.cookie,csrf:f.csrf,body:{input}});assert.equal(options.status,200);
 const assertion=device.assert(options.body.options.challenge);const denied=await f.request('/api/native/decide',{cookie:f.cookie,body:{ceremony_id:options.body.ceremony_id,response:assertion}});assert.equal(denied.status,403);assert.equal(f.db.list().filter(e=>e.event_type==='worker_question_reply').length,0);
 const accepted=await f.request('/api/native/decide',{cookie:f.cookie,csrf:f.csrf,body:{ceremony_id:options.body.ceremony_id,response:assertion}});assert.equal(accepted.status,200);assert.equal(f.writes.length,0);
 assert.equal(f.db.tasks.assertOwner(task.task_id,event.event_id).source_event_id,before);const reply=f.db.get(accepted.body.receipt.event_id)!;assert.equal(reply.reply_target_json,null);assert.equal(JSON.parse(reply.subject_json).actor_id,undefined);
 assert.notEqual((await f.request(`/v1/tasks/${task.task_id}/approve`,{dispatcher:true,body:{source_event_id:reply.event_id,revision:pending.body.revision,question_id:q.question_id,accepted:true}})).status,200);assert.equal(f.writes.length,0);
 assert.equal((await f.request(`/v1/tasks/${task.task_id}/approve`,{dispatcher:true,body:{source_event_id:reply.event_id,revision:pending.body.revision,question_id:q.question_id,accepted:false}})).status,200);assert.deepEqual(f.writes,[{action:'approve',id:q.question_id,accepted:false}]);
 const replay=await f.request('/api/native/decide',{cookie:f.cookie,csrf:f.csrf,body:{ceremony_id:options.body.ceremony_id,response:assertion}});assert.notEqual(replay.status,200);assert.equal(f.writes.length,1);
 const receipt=await f.request('/api/commands/native-one?operation=native_approval',{cookie:f.cookie});assert.deepEqual(receipt.body.receipt,accepted.body.receipt);
}finally{await f.close();}});
