import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {DispatcherDatabase} from '../src/database.js';
import {operatorRequest} from '../src/dashboard/operator-api.js';
import {tempConfig} from './helpers.js';
import {authenticator} from './webauthn-fixture.js';

async function fixture() {
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  db.configureOperatorOrigin('https://dona.example.test');
  const auth=db.operatorAuth,security=db.operatorWebAuthn!,pair=auth.pair(auth.issueCode(['tasks:submit','approvals:native']).code);
  const authority=auth.withSession(pair.token,'tasks:submit',value=>value);
  const created=db.createLocalDashboardTask(authority,{request_id:'create',objective:'承認待ち',workspace:{kind:'scratch'}},config.jobsWorkspaceRoot,config.jobResultsDir);
  const job=created.row;
  db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,'w','p',JSON.stringify(['g','t']));db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const q={question_id:'question',kind:'approval' as const,agent:job.agent_name,generation:'g',thread_id:'t',turn_id:'turn',rpc_id_json:'1',
    payload_json:JSON.stringify({method:'item/commandExecution/requestApproval',command:'echo example'}),state:'pending' as const,answer_hash:null,created_at:new Date().toISOString()};
  db.enqueueWorkerQuestion(job.job_id,q);
  const device=authenticator(),registration=await security.registrationOptions(pair.token);
  await security.register(pair.token,registration.ceremony_id,device.register(registration.options.challenge));
  const input={request_id:'decision',task_id:created.task.task_id,attempt_id:job.job_id,revision:db.tasks.get(created.task.task_id)!.revision,question_id:q.question_id,kind:'approval',accepted:true};
  let wakes=0;
  const context={...config,readQuestions:async()=>[q],wake:()=>{wakes++;}};
  return {root,db,auth,security,pair,authority,input,q,device,context,wakes:()=>wakes,
    async close(){db.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('実WebAuthn署名をexact native要求へ結び、mainへのdecisionとreceiptを一度だけ確定する',async()=>{
  const f=await fixture();try{
    const options=await operatorRequest(f.db,'native/options',{token:f.pair.token,input:f.input},f.context) as {ceremony_id:string;options:{challenge:string}};
    const response=f.device.assert(options.options.challenge);
    const result=await operatorRequest(f.db,'native/decide',{token:f.pair.token,ceremony_id:options.ceremony_id,response},f.context) as {receipt:{operation:string;event_id:string}};
    assert.equal(result.receipt.operation,'native_approval');assert.equal(f.wakes(),1);
    assert.equal(f.db.hasWorkerApprovalReply(f.input.attempt_id,f.q.question_id,result.receipt.event_id,true),true);
    assert.equal(f.db.hasWorkerApprovalReply(f.input.attempt_id,f.q.question_id,result.receipt.event_id,false),false);
    await assert.rejects(operatorRequest(f.db,'native/decide',{token:f.pair.token,ceremony_id:options.ceremony_id,response},f.context));
    const read=await operatorRequest(f.db,'commands/receipt',{token:f.pair.token,input:{request_id:f.input.request_id,operation:'native_approval'}},f.context) as {receipt:unknown};
    assert.deepEqual(read.receipt,result.receipt);assert.equal(f.wakes(),1);
  }finally{await f.close();}
});
test('署名後にnative要求が変わった場合はeventを作らず、権限失効後も受付しない',async()=>{
  const f=await fixture();try{
    const options=await operatorRequest(f.db,'native/options',{token:f.pair.token,input:f.input},f.context) as {ceremony_id:string;options:{challenge:string}};
    f.q.payload_json=JSON.stringify({command:'changed'});
    await assert.rejects(operatorRequest(f.db,'native/decide',{token:f.pair.token,ceremony_id:options.ceremony_id,response:f.device.assert(options.options.challenge)},f.context));
    assert.equal(f.db.getLocalDashboardReceipt(f.authority,'decision'),undefined);assert.equal(f.wakes(),0);
    f.auth.revoke(f.pair.session.device_id);
    await assert.rejects(operatorRequest(f.db,'native/options',{token:f.pair.token,input:f.input},f.context));
  }finally{await f.close();}
});
