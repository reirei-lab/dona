import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
import {fixture,scope,content,wrapping,notification,start} from '../../../dispatcher/test/approval/fixtures/broker.js';
import {executionKey} from '../../../dispatcher/test/approval/fixtures/execution.js';
import {installApprovalExecutionMarkerSchema} from '../../../dispatcher/src/approval/schema.js';
import {emptyMetadataRoot} from '../../../dispatcher/src/approval/metadata-tree.js';
import {LocalExternalApprovalService} from '../../../dispatcher/src/approval/local-external-service.js';
test('reload後の実ledger履歴は期限切れ後もstatusから表示しpresentや判断へ進まない',async({page})=>{
 // 実SQLite・暗号化・監査ledgerの準備も含む統合試験。表示のexpect timeoutは既定のまま。
 test.setTimeout(60000);
 const cleanup:Array<()=>void>=[];let sends=0,presents=0,statuses=0;
 try{
  const {actor,service,completed,expired}=await test.step('実ledgerに実行済み・期限切れの履歴を準備する',async()=>{
   const f=fixture({after(fn){cleanup.push(fn);}});
   installApprovalExecutionMarkerSchema(f.db);
   f.transaction.runPrepared('history_marker',()=>({event:{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},actor:{kind:'system',id:'fixture'},action:'approval_execution',operation:'slack.post_thread_reply.v1',resource_id:'fixture_root',outcome:'succeeded',reason:'none',session_ref:null,receipt_id:null,attempt_id:null,policy_revision:1,binding_revision:1,authz_revision:1},resource_commitments:[{scope:{instance_id:scope.instance_id,tenant_id:scope.workspace_id},resource_id:'approval_execution_markers',resource_digest:emptyMetadataRoot({...scope,collection:'approval_execution_markers_v1'})}],mutation:()=>null}));
   const actor={instance_id:scope.instance_id,owner_id:'operator',device_id:'fixture_device',grant_revision:1};
   const service=new LocalExternalApprovalService(f.db,f.providers,scope,{content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey},{authorize:()=>true,verifyStepUp:()=>true},{observe:async target=>({target,observed_at:start,bot_user_id:'U123',bot_id:'B123',workspace_name:'Workspace',channel_name:'Channel',revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:'a'.repeat(64)}]}}),send:async(_target,_text,_marker,_observation,before)=>{before();sends++;return {outcome:'accepted',receipt_ref:'fixture_receipt'};},reconcile:async()=>({outcome:'unknown'})});
   const intent={workspace_id:scope.workspace_id,channel_id:'C123',thread_ts:'1791080198.497089',text:'履歴本文'};
   const completed=await service.request(actor,{...intent,idempotency_key:'done'}),expired=await service.request(actor,{...intent,idempotency_key:'expire'});if(completed.status==='denied'||expired.status==='denied')throw Error('fixture_denied');
   const presentation=await service.present(actor,completed.request_handle);
   await service.decide(actor,{...actor,receipt_id:'fixture_approved',request_id:completed.request_handle,decision:'approve',presentation_digest:presentation.presentation_digest,expires_at:'2026-09-19T00:01:00.000Z'});
   await service.executePending();expect(service.status(actor,completed.request_handle).execution?.state).toBe('succeeded');
   f.setNow('2026-09-19T00:16:00.000Z');await service.executePending();expect(service.status(actor,expired.request_handle).state).toBe('expired');
   return {actor,service,completed,expired};
  });
  await test.step('reload後の履歴表示と追加送信なしを確認する',async()=>{
   await page.addInitScript(id=>sessionStorage.setItem('dona.pending-external',id),expired.request_handle);
   await page.route('https://operator.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
    if(path==='/api/session')value={csrf:'csrf',capabilities:['approvals:external']};else if(path==='/api/credential')value={registered:true,can_enroll:false};
    else if(path==='/api/approvals')value={available:true,...service.list(actor)};
    else if(path.endsWith('/status')){statuses++;value=service.status(actor,path.split('/').at(-2)!);}
    else{presents++;throw Error('履歴からpresent/判断の呼出しは禁止');}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  for(const id of [completed.request_handle,expired.request_handle]){
   await page.goto('https://operator.test/');await page.reload();await page.locator(`[data-external="${id}"]`).click();await expect(page.locator('#external-detail')).toContainText('外部操作の履歴');
   await expect(page.locator('#external-status')).toContainText(id===completed.request_handle?'実行: 実行成功':'要求: 期限切れ');await expect(page.getByRole('button',{name:'この外部操作を許可'})).toHaveCount(0);
   if(id===completed.request_handle)expect(await page.evaluate(()=>sessionStorage.getItem('dona.pending-external'))).toBe(expired.request_handle);
  }
  expect(statuses).toBe(2);expect(presents).toBe(0);expect(sends).toBe(1);
  });
 }finally{for(const close of cleanup.reverse())close();}
});
