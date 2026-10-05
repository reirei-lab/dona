import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
test.use({locale:'ja-JP',timezoneId:'Asia/Tokyo'});
async function setup(page:any,drift=false){
 const client=await page.context().newCDPSession(page);await client.send('WebAuthn.enable');await client.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 let registration:any,registered=false,reads=0,options=0,decisions=0,statuses=0;const digest='hidden_digest',expires_at=new Date(Date.now()+600000).toISOString();
 await page.route('https://operator.test/**',async(route:any)=>{const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['approvals:external']};
  else if(url.pathname==='/api/credential')value={registered,can_enroll:true};
  else if(url.pathname==='/api/credential/options')value={ceremony_id:'register',options:{challenge:Buffer.alloc(32,1).toString('base64url'),rp:{name:'Dona',id:'operator.test'},user:{id:Buffer.alloc(16,2).toString('base64url'),name:'operator',displayName:'Operator'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'required'},timeout:5000,attestation:'none'}};
  else if(url.pathname==='/api/credential/register'){registration=route.request().postDataJSON();registered=true;value={registered:true};}
  else if(url.pathname==='/api/approvals')value={available:true,items:[{request_id:'approval_one',operation:'slack.post_thread_reply.v1',state:'pending',execution:null}],next:null};
  else if(url.pathname==='/api/approvals/approval_one'){if(decisions){await route.fulfill({status:409,contentType:'application/json',body:'{}'});return;}reads++;value={request_id:'approval_one',operation:'slack.post_thread_reply.v1',workspace_id:'T_ONE',workspace_name:'個人のDona',channel_id:'C_ONE',channel_name:'開発相談',thread_ts:'123.456',exact_draft:'<a href="https://evil.test">literal draft</a>',notified_user_ids:['U_ONE'],expires_at:expires_at,request_revision:drift&&reads>1?2:1,presentation_revision:1,presentation_digest:digest};}
  else if(url.pathname.endsWith('/options')){options++;expect(route.request().postDataJSON()).toEqual({decision:'approve',presentation_digest:digest});value={ceremony_id:'external',options:{challenge:Buffer.alloc(32,3).toString('base64url'),rpId:'operator.test',allowCredentials:[{id:registration.response.id,type:'public-key'}],userVerification:'required',timeout:5000}};}
  else if(url.pathname==='/api/approvals/decide'){decisions++;expect(route.request().postDataJSON().response.response.signature).toEqual(expect.any(String));await route.abort();return;}
  else if(url.pathname.endsWith('/status')){statuses++;value={request_id:'approval_one',state:statuses===1?'pending':'approved',decision:statuses===1?null:{kind:'approve',decided_at:'now'},execution:statuses===1?null:{state:statuses>2?'succeeded':'running',receipt_ref:'hidden_receipt_path'}};}
  else throw Error(url.pathname);
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByRole('button',{name:'承認用パスキーを登録'}).click();await expect(page.locator('#credential-status')).toContainText('登録済み');await page.getByRole('button',{name:/Slackスレッドへの返信/}).click();
 return {counts:()=>({reads,options,decisions,statuses})};
}
test('外部操作のexact宛先・本文を表示し、virtual passkey判断の応答喪失後はstatusのみ照合する',async({page},testInfo)=>{
 const fixture=await setup(page);await expect(page.locator('#external-detail')).toContainText('ワークスペース: 個人のDona（T_ONE）');await expect(page.locator('#external-detail')).toContainText('チャンネル: 開発相談（C_ONE）');await expect(page.locator('#external-detail')).toContainText('スレッド: 123.456');await expect(page.locator('#external-detail')).toContainText('日本標準時');await expect(page.locator('#external-detail')).toContainText('C_ONE');await expect(page.locator('#external-detail')).toContainText('123.456');await expect(page.locator('#external-detail')).toContainText('U_ONE');await expect(page.locator('#external-detail')).toContainText('literal draft');await expect(page.locator('#external-detail a')).toHaveCount(0);await expect(page.locator('#external-detail')).not.toContainText('hidden_digest');
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:testInfo.outputPath('external-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('external-mobile.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.getByRole('button',{name:'この外部操作を許可'}).click();await expect(page.locator('#external-status')).toContainText('自動再送しません');expect(fixture.counts().decisions).toBe(1);await expect(page.getByRole('button',{name:'この外部操作を許可'})).toBeDisabled();
 await page.getByRole('button',{name:'外部操作の状態を確認'}).click();await expect(page.locator('#external-status')).toContainText('判断: 許可');await expect(page.locator('#external-status')).toContainText('実行: 実行中');await expect(page.locator('#external-status')).not.toContainText('実行成功');await expect(page.locator('#external-panel')).not.toContainText('hidden_receipt_path');expect(fixture.counts().decisions).toBe(1);expect(fixture.counts().options).toBe(1);await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#external-status')).toContainText('実行成功');expect(fixture.counts().decisions).toBe(1);
});
test('表示後のrevision driftではchallengeも判断も送らない',async({page})=>{
 const fixture=await setup(page,true);await page.getByRole('button',{name:'この外部操作を許可'}).click();await expect(page.locator('#external-status')).toContainText('表示後に内容が変わった');expect(fixture.counts().options).toBe(0);expect(fixture.counts().decisions).toBe(0);await expect(page.getByRole('button',{name:'この外部操作を許可'})).toBeDisabled();
});
test('外部承認provider未設定を接続障害と区別し操作ボタンを表示しない',async({page})=>{
 await page.route('https://operator.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/'){await route.fulfill(observerDashboardPage());return;}const value=path==='/api/session'?{csrf:'csrf',capabilities:['approvals:external']}:path==='/api/credential'?{registered:true,can_enroll:false}:{available:false,reason:'setup_required'};await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
 await page.goto('https://operator.test/');await expect(page.locator('#external-panel')).toContainText('外部操作承認の準備が必要');await expect(page.locator('#connection')).toContainText('接続中');await expect(page.getByRole('button',{name:'この外部操作を許可'})).toHaveCount(0);
});
