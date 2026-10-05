import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,scope,content,wrapping,notification,start} from './approval/fixtures/broker.js';
import {executionKey} from './approval/fixtures/execution.js';
import {installApprovalExecutionMarkerSchema} from '../src/approval/schema.js';
import {emptyMetadataRoot} from '../src/approval/metadata-tree.js';
import {LocalExternalApprovalService} from '../src/approval/local-external-service.js';
import {OperatorAuthRegistry} from '../src/dashboard/operator-auth.js';
import {OperatorWebAuthn} from '../src/dashboard/operator-webauthn.js';
import {operatorRequest} from '../src/dashboard/operator-api.js';
import type {DispatcherDatabase} from '../src/database.js';
import {authenticator} from './webauthn-fixture.js';

for(const lost of [false,true])test(`外部操作のWeb入力から実署名・ledger・status照合まで接続する (commit後error: ${lost})`,async t=>{
  const f=fixture(t);installApprovalExecutionMarkerSchema(f.db);
  f.transaction.runPrepared('dashboard_marker',()=>({event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},
    actor:{kind:'system',id:'fixture'},action:'approval_execution',operation:'slack.post_thread_reply.v1',resource_id:'fixture_root',
    outcome:'succeeded',reason:'none',session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},
    resource_commitments:[{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},resource_id:'approval_execution_markers',
      resource_digest:emptyMetadataRoot({...scope,collection:'approval_execution_markers_v1'})}],mutation:()=>null}));
  new OperatorAuthRegistry(f.db);
  f.db.prepare('UPDATE dashboard_operator_identity SET instance_id=?').run(scope.instance_id);
  const auth=new OperatorAuthRegistry(f.db),pair=auth.pair(auth.issueCode(['approvals:external']).code);
  const security=new OperatorWebAuthn(f.db,auth,'https://dona.example.test',()=>0,()=>Date.parse(start));
  const actor=auth.withSession(pair.token,'approvals:external',value=>value),device=authenticator();
  const registration=await security.registrationOptions(pair.token);
  await security.register(pair.token,registration.ceremony_id,device.register(registration.options.challenge));
  let calls=0,failObservation=false;
  const service=new LocalExternalApprovalService(f.db,f.providers,scope,{
    content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey,
  },{authorize:value=>auth.authorize(value,'approvals:external'),verifyStepUp:value=>security.verifyReceipt(value,value,'approvals:external')},{
    observe:async target=>{if(failObservation)throw Error("fixture_observation_unavailable");return {target,observed_at:start,bot_user_id:'U123',bot_id:'B123',workspace_name:'Fixture',channel_name:'Channel',
      revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:'a'.repeat(64)}]}};},
    send:async(_target,_text,_marker,_observation,before)=>{before();calls++;return {outcome:'accepted',receipt_ref:'fixture_receipt'};},
    reconcile:async()=>({outcome:'unknown'}),
  });
  // Only the broker's protected clock/Keychain and external network are fixtures.
  // Device authorization, cryptographic verification and all ledger writes run.
  const db={operatorAuth:auth,operatorWebAuthn:security} as DispatcherDatabase;
  const context={jobsWorkspaceRoot:'/unused',jobResultsDir:'/unused',readQuestions:async()=>[],wake:()=>{},external:service};
  const created=await service.request(actor,{idempotency_key:'input',workspace_id:scope.workspace_id,channel_id:'C123',thread_ts:'1791080198.497089',text:'承認した本文だけ'});
  if(created.status==='denied')throw Error('fixture_denied');
  const request_id=created.request_handle;
  const view=await operatorRequest(db,'external/present',{token:pair.token,request_id},context) as {presentation_digest:string};
  await assert.rejects(operatorRequest(db,'external/options',{token:pair.token,request_id,decision:'approve',presentation_digest:'b'.repeat(64)},context));
  const invalidOptions=await operatorRequest(db,'external/options',{token:pair.token,request_id,decision:'approve',presentation_digest:view.presentation_digest},context) as {ceremony_id:string;options:{challenge:string}};
  const bad=device.assert(invalidOptions.options.challenge);bad.response.signature=Buffer.alloc(64).toString('base64url');
  const rejected=await operatorRequest(db,'external/decide',{token:pair.token,ceremony_id:invalidOptions.ceremony_id,response:bad},context);
  assert.deepEqual(rejected,{rejection:{request_id,operation:'external_approval',code:'conflict',not_committed:true}});
  const before=await operatorRequest(db,'external/status',{token:pair.token,request_id},context) as {decision:unknown};assert.equal(before.decision,null);
  const offlineOptions=await operatorRequest(db,'external/options',{token:pair.token,request_id,decision:'approve',presentation_digest:view.presentation_digest},context) as {ceremony_id:string;options:{challenge:string}};
  failObservation=true;
  const offline=await operatorRequest(db,'external/decide',{token:pair.token,ceremony_id:offlineOptions.ceremony_id,response:device.assert(offlineOptions.options.challenge)},context);
  assert.deepEqual(offline,{rejection:{request_id,operation:'external_approval',code:'conflict',not_committed:true}});
  assert.equal(service.status(actor,request_id).decision,null);failObservation=false;
  const options=await operatorRequest(db,'external/options',{token:pair.token,request_id,decision:'approve',presentation_digest:view.presentation_digest},context) as {ceremony_id:string;options:{challenge:string}};
  const body={token:pair.token,ceremony_id:options.ceremony_id,response:device.assert(options.options.challenge,{counter:2})};
  const other=auth.pair(auth.issueCode(['approvals:external']).code),otherDevice=authenticator();
  const enrollment=await security.registrationOptions(other.token);await security.register(other.token,enrollment.ceremony_id,otherDevice.register(enrollment.options.challenge));
  const otherOptions=await operatorRequest(db,'external/options',{token:other.token,request_id,decision:'reject',presentation_digest:view.presentation_digest},context) as {ceremony_id:string;options:{challenge:string}};
  if(lost){const decide=service.decide.bind(service);service.decide=async(...args)=>{await decide(...args);throw Error('after_commit');};await assert.rejects(operatorRequest(db,'external/decide',body,context),/after_commit/);}
  else{const result=await operatorRequest(db,'external/decide',body,context) as {status:string};assert.equal(result.status,'decided');}
  assert.equal(calls,0);
  // Simulate a lost response: read the exact request, never resend decide/send.
  const status=await operatorRequest(db,'external/status',{token:pair.token,request_id},context) as {decision:{kind:string};execution:unknown};
  assert.equal(status.decision.kind,'approve');assert.equal(status.execution,null);
  const otherResponse=otherDevice.assert(otherOptions.options.challenge);otherResponse.response.signature=Buffer.alloc(64).toString('base64url');
  await assert.rejects(operatorRequest(db,'external/decide',{token:other.token,ceremony_id:otherOptions.ceremony_id,response:otherResponse},context),/external_approval_reconciliation_required/);
  assert.equal((await service.status(actor,request_id)).decision?.kind,'approve');
  await service.executePending();await service.executePending();assert.equal(calls,1);
  const final=await operatorRequest(db,'external/status',{token:pair.token,request_id},context) as {execution:{state:string}};
  assert.equal(final.execution.state,'succeeded');
  await assert.rejects(operatorRequest(db,'external/decide',body,context));assert.equal(calls,1);
  auth.revoke(actor.device_id);await assert.rejects(operatorRequest(db,'external/status',{token:pair.token,request_id},context));
});
