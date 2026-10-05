import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type Database from "better-sqlite3";
import {test} from "node:test";
import {DispatcherDatabase} from "../src/database.js";
import {OperatorAuthRegistry} from "../src/dashboard/operator-auth.js";
import {operatorCommand,operatorQuestions,operatorNativeApproval} from "../src/dashboard/operator-commands.js";
import {tempConfig} from "./helpers.js";
async function fixture(caps:string[]=["tasks:submit","tasks:cancel","approvals:native"]){const {root,config}=await tempConfig();const original=new DispatcherDatabase(config.databasePath);const auth=new OperatorAuthRegistry((original as unknown as {db:Database.Database}).db);const db=Object.assign(original,{operatorAuth:auth});const session=auth.pair(auth.issueCode(caps).code);const authority=auth.withSession(session.token,"tasks:submit",value=>value);return {db,auth,session,authority,config,async dispose(){db.close();await fs.rm(root,{recursive:true,force:true});}};}
const create={operation:"create",input:{request_id:"first",objective:"ローカル操作",workspace:{kind:"scratch" as const}}};
test("submitだけの端末で依頼・receiptを照合でき、内部pathやownerを返さない",async()=>{const f=await fixture(["tasks:submit"]);try{
 const result=operatorCommand(f.db,f.config,{token:f.session.token,...create});assert.ok('task'in result);assert.equal(result.receipt?.operation,"create");
 assert.doesNotMatch(JSON.stringify(result),/workspace_path|result_path|instance_id|owner_id|canonical_sha256|ローカル操作/);
 const lookup=operatorCommand(f.db,f.config,{token:f.session.token,operation:"receipt",input:{request_id:"first",operation:"create"}});assert.deepEqual(lookup.receipt,result.receipt);
 assert.throws(()=>operatorCommand(f.db,f.config,{token:f.session.token,operation:"cancel",input:{request_id:"cancel",task_id:result.receipt!.task_id,attempt_id:result.receipt!.attempt_id,revision:result.receipt!.task_revision}}),/denied/);
 f.auth.revoke(f.session.session.device_id);assert.throws(()=>operatorCommand(f.db,f.config,{token:f.session.token,...create}),/denied/);
}finally{await f.dispose();}});
test("workspace入力と追加authority fieldはstrictに拒否しnative approvalをtokenだけで受理しない",async()=>{const f=await fixture();try{
 for(const workspace of [{kind:"scratch",path:"/tmp/elsewhere"},{kind:"github",repository:"../../private"}])assert.throws(()=>operatorCommand(f.db,f.config,{token:f.session.token,...create,input:{...create.input,workspace}}));
 assert.throws(()=>operatorCommand(f.db,f.config,{token:f.session.token,...create,owner_id:"forged"}));assert.throws(()=>operatorCommand(f.db,f.config,{token:f.session.token,operation:"native_approval",input:{}}));assert.equal(f.db.tasks.scanSnapshot().length,0);
}finally{await f.dispose();}});
test("質問readはruntime I/O中のdevice失効を再検証する",async()=>{const f=await fixture();try{
 const created=f.db.createLocalDashboardTask(f.authority,create.input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir);const job=created.row;f.db.beginJobPreparation(job.job_id);f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));
 await assert.rejects(operatorQuestions(f.db,{token:f.session.token,task_id:created.task.task_id,kind:"question"},async()=>{f.auth.revoke(f.session.session.device_id);return [];}),/denied/);
}finally{await f.dispose();}});
test("native承認は検証callback内でのみ受付し、質問は現行ownerへ束縛する",async()=>{const f=await fixture();try{
 const created=f.db.createLocalDashboardTask(f.authority,create.input,f.config.jobsWorkspaceRoot,f.config.jobResultsDir),job=created.row;
 f.db.beginJobPreparation(job.job_id);f.db.setJobRuntime(job.job_id,"w","p",JSON.stringify(["g","t"]));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
 const q={question_id:"q",kind:"approval" as const,agent:job.agent_name,generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:"1",payload_json:'{"command":"test"}',state:"pending" as const,answer_hash:null,created_at:new Date().toISOString()};f.db.enqueueWorkerQuestion(job.job_id,q);
 const found=await operatorQuestions(f.db,{token:f.session.token,task_id:created.task.task_id,kind:"approval"},async()=>[q,{...q,generation:"old"}]);assert.equal(found.questions.length,1);
 const input={request_id:"approve",task_id:created.task.task_id,attempt_id:job.job_id,revision:found.revision,question_id:"q",kind:"approval",accepted:false};
 assert.throws(()=>operatorNativeApproval(f.db,{token:f.session.token,input},()=>{throw Error("webauthn_required");}),/webauthn_required/);assert.equal(f.db.getLocalDashboardReceipt(f.authority,"approve"),undefined);
 const result=operatorNativeApproval(f.db,{token:f.session.token,input},(authority,verified,commit)=>{assert.equal(authority.device_id,f.session.session.device_id);assert.equal(verified.accepted,false);return commit();});assert.equal(result.receipt.operation,"native_approval");
}finally{await f.dispose();}});

test("Slack Taskのnative approvalをoperator receiptで限定許可し元ownerを保持する",async()=>{const f=await fixture();try{
 const {eventEnvelope}=await import('./helpers.js');const {taskRequestSchema}=await import('../src/task-execution.js');const {JobSupervisor}=await import('../src/job-supervisor.js');
 const event=f.db.enqueue(eventEnvelope('slack-native')).row;
 const task=f.db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'slack-task',objective:'Slack依頼',workspace:{kind:'scratch'}}),f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task,job=f.db.getJob(task.current_attempt_id)!;
 const sql=(f.db as unknown as {db:Database.Database}).db,original=sql.prepare('SELECT owner_json FROM job_owner_bindings WHERE job_id=?').get(job.job_id);
 f.db.beginJobPreparation(job.job_id);f.db.setJobRuntime(job.job_id,'w','p',JSON.stringify(['g','t']));f.db.beginJobDispatch(job.job_id);f.db.markJobRunning(job.job_id);
 const q={question_id:'slack_approval',kind:'approval' as const,agent:job.agent_name,generation:'g',thread_id:'t',turn_id:'turn',rpc_id_json:'1',payload_json:'{"command":"test"}',state:'pending' as const,answer_hash:null,created_at:new Date().toISOString()};f.db.enqueueWorkerQuestion(job.job_id,q);
 await assert.rejects(operatorQuestions(f.db,{token:f.session.token,task_id:task.task_id,kind:'question'},async()=>[q]),/owner_mismatch/);
 const pending=await operatorQuestions(f.db,{token:f.session.token,task_id:task.task_id,kind:'approval'},async()=>[q]);assert.equal(pending.questions.length,1);
 const input={request_id:'slack-decision',task_id:task.task_id,attempt_id:job.job_id,revision:pending.revision,question_id:q.question_id,kind:'approval',accepted:true};
 const decision=operatorNativeApproval(f.db,{token:f.session.token,input},(_authority,_input,commit)=>commit());const reply=f.db.get(decision.receipt.event_id)!;
 assert.equal(reply.source,'web');assert.equal(reply.reply_target_json,null);assert.equal(JSON.parse(reply.subject_json).actor_id,undefined);
 assert.deepEqual(sql.prepare('SELECT owner_json FROM job_owner_bindings WHERE job_id=?').get(job.job_id),original);
 assert.throws(()=>f.db.tasks.assertOwner(task.task_id,reply.event_id),/owner_mismatch/);
 let approvals=0;const runtime:import('../src/job-runtime.js').JobAgentRuntime={async prepare(){throw Error('unused');},async get(){throw Error('unused');},async prompt(){throw Error('unused');},async wait(){throw Error('unused');},async cancel(){throw Error('unused');},async questions(){return [q,{...q,question_id:'unrelated'}];},async approveRequest(){approvals++;return {...q,state:'resolved'};}};
 const supervisor=new JobSupervisor(f.db,runtime,f.config,{debug(){},info(){},warn(){},error(){}},()=>{});
 const visible=await supervisor.taskQuestions(task.task_id,reply.event_id) as {questions:unknown[]};assert.equal(visible.questions.length,1);
 await assert.rejects(supervisor.approveTaskRequest(task.task_id,reply.event_id,pending.revision,q.question_id,false),/requires_user_reply/);
 await assert.rejects(supervisor.approveTaskRequest(task.task_id,reply.event_id,pending.revision,'unrelated',true),/requires_user_reply/);
 await supervisor.approveTaskRequest(task.task_id,reply.event_id,pending.revision,q.question_id,true);assert.equal(approvals,1);
}finally{await f.dispose();}});

test("再起動後の再pairは旧端末のreceiptを現在の操作権限で照合し二重作成しない",async()=>{const f=await fixture();try{
 const original=operatorCommand(f.db,f.config,{token:f.session.token,...create});
 f.auth.resetSessions();
 const readOnly=f.auth.pair(f.auth.issueCode(['tasks:read']).code);
 const lookup={operation:'receipt',input:{request_id:'first',operation:'create'}};
 assert.throws(()=>operatorCommand(f.db,f.config,{token:readOnly.token,...lookup}),/denied/);
 const next=f.auth.pair(f.auth.issueCode(['tasks:submit']).code);
 assert.notEqual(next.session.device_id,f.session.session.device_id);
 assert.deepEqual(operatorCommand(f.db,f.config,{token:next.token,...lookup}).receipt,original.receipt);
 const recovered=operatorCommand(f.db,f.config,{token:next.token,...create});
 assert.ok('outcome' in recovered);assert.equal(recovered.outcome,'reused');assert.equal(f.db.tasks.scanSnapshot().length,1);
 assert.throws(()=>operatorCommand(f.db,f.config,{token:next.token,...create,input:{...create.input,objective:'異なる依頼'}}),/conflict/);
 f.auth.revoke(next.session.device_id);assert.throws(()=>operatorCommand(f.db,f.config,{token:next.token,...lookup}),/denied/);
}finally{await f.dispose();}});
