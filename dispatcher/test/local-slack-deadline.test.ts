import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LocalSlackApprovalProvider} from '../src/approval/local-slack-provider.js';
test('Slackの複数API照合は同じ期限を共有し期限後の次callを開始しない',async t=>{
 const control=new AbortController();t.mock.method(AbortSignal,'timeout',()=>control.signal);
 let calls=0;
 const provider=new LocalSlackApprovalProvider('T123',async()=>'fixture',Buffer.alloc(32,1),(async(_url,init)=>{
  calls++;assert.equal(init?.signal,control.signal);control.abort();
  return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
 }) as typeof fetch);
 await assert.rejects(provider.observe({workspace_id:'T123',channel_id:'C123',thread_ts:'1791080198.497089'}));
 assert.equal(calls,1);
});
