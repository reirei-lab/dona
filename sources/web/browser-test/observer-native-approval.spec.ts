import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
for(const accepted of [true,false])test(`virtual authenticatorでnative要求を${accepted?'許可':'拒否'}し応答喪失時はreceiptだけ照合する`,async({page})=>{
 const client=await page.context().newCDPSession(page);await client.send('WebAuthn.enable');await client.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 let registration:any,input:any,assertion:any,registered=false,decisions=0,lookups=0,options=0;
 const task={task_id:'task_one',task_key:'承認待ち',state:'waiting',desired_state:'running',revision:7,current_attempt_id:'attempt_one',worker_status:'blocked',updated_at:'now'};
 await page.route('https://operator.test/**',async route=>{
  const url=new URL(route.request().url());if(url.pathname==='/'){await route.fulfill(observerDashboardPage());return;}let value:unknown;
  if(url.pathname==='/api/session')value={csrf:'csrf',capabilities:['tasks:read','approvals:native']};
  else if(url.pathname==='/api/credential')value={registered,can_enroll:true};
  else if(url.pathname==='/api/credential/options')value={ceremony_id:'register',options:{challenge:Buffer.alloc(32,1).toString('base64url'),rp:{name:'Dona',id:'operator.test'},user:{id:Buffer.alloc(16,2).toString('base64url'),name:'operator',displayName:'Operator'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'required'},timeout:5000,attestation:'none'}};
  else if(url.pathname==='/api/credential/register'){registration=route.request().postDataJSON();registered=true;value={registered:true};}
  else if(url.pathname==='/api/tasks')value={items:[task],next:null};
  else if(url.pathname.endsWith('/questions')){expect(url.searchParams.get('kind')).toBe('approval');value={task_id:task.task_id,current_attempt_id:'attempt_one',revision:7,questions:[{question_id:'approval_one',kind:'approval',state:'pending',request:{method:'item/commandExecution/requestApproval',command:'echo "<img src=x onerror=alert(1)>"',cwd:'/fixture',reason:'実行前の確認',threadId:'hidden_thread'}}]};}
  else if(url.pathname==='/api/native/options'){options++;input=route.request().postDataJSON().input;value={ceremony_id:'native',options:{challenge:Buffer.alloc(32,3).toString('base64url'),rpId:'operator.test',allowCredentials:[{id:registration.response.id,type:'public-key'}],userVerification:'required',timeout:5000}};}
  else if(url.pathname==='/api/native/decide'){decisions++;assertion=route.request().postDataJSON();expect(route.request().headers()['x-csrf-token']).toBe('csrf');await route.abort();return;}
  else if(url.pathname.startsWith('/api/commands/')){lookups++;expect(url.searchParams.get('operation')).toBe('native_approval');value={receipt:lookups===1?null:{request_id:input.request_id,operation:'native_approval',task_id:task.task_id}};}
  else value={snapshot:{task,attempts:[],selected_attempt_id:'attempt_one'},runtime:{status:'not_started'}};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');await page.getByRole('button',{name:'承認用パスキーを登録'}).click();await expect(page.locator('#credential-status')).toContainText('登録済み');
 await page.getByRole('button',{name:'承認待ち · 待機中'}).click();await expect(page.locator('#detail')).toContainText('echo');await expect(page.locator('#detail img')).toHaveCount(0);await expect(page.locator('#detail')).not.toContainText('hidden_thread');
 const button=page.getByRole('button',{name:accepted?'この要求を許可':'この要求を拒否'});await button.click();await expect(page.locator('#command-status')).toContainText('まだ確認できません');
 expect(input).toMatchObject({task_id:'task_one',attempt_id:'attempt_one',revision:7,question_id:'approval_one',kind:'approval',accepted});expect(assertion.ceremony_id).toBe('native');expect(typeof assertion.response.response.signature).toBe('string');expect(options).toBe(1);expect(decisions).toBe(1);await expect(button).toBeDisabled();
 await page.getByRole('button',{name:'受付状況を確認'}).click();await expect(page.locator('#command-status')).toContainText('承認判断を受け付けました');expect(decisions).toBe(1);expect(options).toBe(1);
});
