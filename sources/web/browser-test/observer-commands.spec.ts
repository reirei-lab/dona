import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
test('操作専用端末はTask一覧を要求せず、応答喪失後は受付照合だけを行う',async({page})=>{
 let posts=0,lookups=0,body:any;const paths:string[]=[];
 await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());paths.push(url.pathname);
  if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}
  let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['tasks:submit']};
  else if(url.pathname==='/api/tasks'&&route.request().method()==='POST'){posts++;body=route.request().postDataJSON();expect(route.request().headers()['x-csrf-token']).toBe('csrf');await route.abort();return;}
  else if(url.pathname.startsWith('/api/commands/')){lookups++;value={receipt:lookups===1?null:{request_id:body.request_id,operation:'create',task_id:'task_new'}};}
  else throw Error('unexpected '+url.pathname);
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByLabel('Donaへの依頼').fill('依頼本文');await page.getByRole('button',{name:'依頼する',exact:true}).click();
 await expect(page.locator('#command-status')).toContainText('まだ確認できません');await expect(page.getByRole('button',{name:'依頼する',exact:true})).toBeDisabled();expect(posts).toBe(1);
 await page.getByRole('button',{name:'受付状況を確認'}).click();await expect(page.locator('#command-status')).toContainText('依頼を受け付けました');expect(posts).toBe(1);expect(lookups).toBe(2);expect(paths.filter(p=>p==='/api/tasks')).toHaveLength(1);
});
test('main会話だけの端末はTask閲覧を要求しない',async({page})=>{
 const paths:string[]=[];await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());paths.push(url.pathname);if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}const value=url.pathname==='/api/session'?{csrf:'csrf',capabilities:['conversations:main:read']}:{items:[],next:null};await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
 await page.goto('https://operator.test/');await expect(page.locator('#connection')).toContainText('接続中');expect(paths).not.toContain('/api/tasks');await expect(page.locator('#task-panel')).toBeHidden();
});
test('質問文と選択肢からexact Attempt/revisionへの回答をDonaへ送る',async({page})=>{
 let response:any;const task={local_operator_owned:true,task_id:'task_one',task_key:'調査',state:'waiting',desired_state:'running',revision:7,current_attempt_id:'attempt_one',worker_status:'blocked',updated_at:'now'};
 await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['tasks:read','tasks:submit']};
  else if(url.pathname==='/api/tasks')value={items:[task],next:null};
  else if(url.pathname.endsWith('/questions'))value={task_id:task.task_id,current_attempt_id:'attempt_one',revision:7,questions:[{question_id:'question_one',kind:'question',state:'pending',request:{questions:[{id:'target',header:'対象',question:'どちらを調べますか？',options:[{label:'A',description:'先にAを調査'},{label:'B',description:'先にBを調査'}]}]}}]};
  else if(url.pathname.endsWith('/reply')){response=route.request().postDataJSON();value={receipt:{request_id:response.request_id,operation:'question_reply',task_id:task.task_id}};}
  else value={snapshot:{task,attempts:[],selected_attempt_id:'attempt_one'},runtime:{status:'not_started'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByRole('button',{name:'調査 · 待機中'}).click();await page.getByLabel('どちらを調べますか？').selectOption('B');await page.getByRole('button',{name:'回答をDonaに送る'}).click();await expect(page.locator('#command-status')).toContainText('回答を受け付けました');expect(response).toMatchObject({attempt_id:'attempt_one',revision:7,kind:'question',answers:{target:{answers:['B']}}});
});

test('承認権限を持つ端末でパスキーを登録する',async({page})=>{
 const client=await page.context().newCDPSession(page);await client.send('WebAuthn.enable');await client.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 let registered=false,registration:any;
 await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['approvals:native']};
  else if(url.pathname==='/api/credential')value={registered,can_enroll:true};
  else if(url.pathname==='/api/credential/options')value={ceremony_id:'ceremony',options:{challenge:Buffer.alloc(32,1).toString('base64url'),rp:{name:'Dona',id:'operator.test'},user:{id:Buffer.alloc(16,2).toString('base64url'),name:'operator',displayName:'Operator'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'required'},timeout:5000,attestation:'none'}};
  else if(url.pathname==='/api/credential/register'){registration=route.request().postDataJSON();registered=true;value={registered:true};}
  else throw Error('unexpected '+url.pathname);
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByRole('button',{name:'承認用パスキーを登録'}).click();await expect(page.locator('#credential-status')).toContainText('登録済み');expect(registration.ceremony_id).toBe('ceremony');expect(typeof registration.response.response.attestationObject).toBe('string');
});

test('Slack起点Taskには取消と通常質問を出さずnative承認の取得だけを維持する',async({page})=>{
 let nativeReads=0;const task={task_id:'task_slack',task_key:'Slack依頼',local_operator_owned:false,state:'waiting',desired_state:'running',revision:3,current_attempt_id:'attempt_slack',worker_status:'blocked',updated_at:'now'};
 await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['tasks:read','tasks:submit','tasks:cancel','approvals:native']};
  else if(url.pathname==='/api/credential')value={registered:true,can_enroll:false};
  else if(url.pathname==='/api/tasks')value={items:[task],next:null};
  else if(url.pathname.endsWith('/questions')){expect(url.searchParams.get('kind')).toBe('approval');nativeReads++;value={task_id:task.task_id,current_attempt_id:task.current_attempt_id,revision:3,questions:[]};}
  else value={snapshot:{task,attempts:[],selected_attempt_id:task.current_attempt_id},runtime:{status:'unavailable'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByRole('button',{name:'Slack依頼 · 待機中'}).click();await expect(page.locator('#detail h2')).toHaveText('Slack依頼');
 await expect.poll(()=>nativeReads).toBe(1);await expect(page.getByRole('button',{name:'このTaskを取り消す'})).toHaveCount(0);await expect(page.getByRole('button',{name:'回答をDonaに送る'})).toHaveCount(0);
});

for(const responseKind of ['rejected','unknown','wrong-request'] as const)test(`確定拒否だけが新規依頼を可能にする: ${responseKind}`,async({page})=>{
 let posts=0,lookups=0;
 await page.route('https://operator.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;let status=200;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['tasks:submit']};
  else if(url.pathname==='/api/tasks'){posts++;const body=route.request().postDataJSON();status=responseKind==='unknown'?503:409;value=responseKind==='unknown'?{error:'observation_unavailable'}:{rejection:{request_id:responseKind==='wrong-request'?'other':body.request_id,operation:'create',code:'invalid',not_committed:true}};}
  else if(url.pathname.startsWith('/api/commands/')){lookups++;value={receipt:null};}
  else throw Error(url.pathname);
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByLabel('Donaへの依頼').fill('依頼');const button=page.getByRole('button',{name:'依頼する',exact:true});await button.click();
 if(responseKind==='rejected'){await expect(page.locator('#command-status')).toContainText('受け付けられませんでした');await expect(button).toBeEnabled();await button.click();await expect.poll(()=>posts).toBe(2);expect(lookups).toBe(0);}
 else{await expect(page.locator('#command-status')).toContainText('まだ確認できません');await expect(button).toBeDisabled();expect(posts).toBe(1);}
});
