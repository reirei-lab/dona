import {expect,test} from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {operatorStackFixture,fixtureWebAuthnClock} from '../../../dispatcher/test/operator-stack-fixture.js';
import {observerDashboardPage} from '../src/observer-dashboard.js';
import {fixture,content,wrapping,notification,start} from '../../../dispatcher/test/approval/fixtures/broker.js';
import {executionKey} from '../../../dispatcher/test/approval/fixtures/execution.js';
import {initializeLocalApprovalRoots} from '../../../dispatcher/src/approval/local-native.js';
import {installApprovalExecutionMarkerSchema} from '../../../dispatcher/src/approval/schema.js';
import {LocalExternalApprovalService} from '../../../dispatcher/src/approval/local-external-service.js';
async function freePort(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
test('HTTPS外部承認は実WebAuthn・保護ledger・one-shot送信を通り応答喪失からterminal履歴へ収束する',async({browser})=>{
 const cleanup:Array<()=>void>=[],ledger=fixture({after(fn){cleanup.push(fn);}},false),port=await freePort(),origin=`https://localhost:${port}`;
 const f=await operatorStackFixture({origin,page:observerDashboardPage()}),context=await browser.newContext({ignoreHTTPSErrors:true});
 const scope={instance_id:f.db.operatorAuth.instance_id,workspace_id:'tenant'};
 installApprovalExecutionMarkerSchema(ledger.db);initializeLocalApprovalRoots(ledger.db,ledger.providers,scope);
 // Production crypto/registry, with only the clock fixed to the protected ledger fixture.
 const closeSecurity=fixtureWebAuthnClock(f.db,f.config.databasePath,origin,()=>Date.parse(start));
 let sends=0,decisions=0,statusReads=0,dropped=false;
 const service=new LocalExternalApprovalService(ledger.db,ledger.providers,scope,{content:()=>content,wrapping:()=>wrapping,notification:()=>notification,wrappingVersion:()=>wrapping,notificationVersion:()=>notification,execution:()=>executionKey},{authorize:a=>f.db.operatorAuth.authorize(a,'approvals:external'),verifyStepUp:r=>f.db.operatorWebAuthn!.verifyReceipt(r,r,'approvals:external')},{
  observe:async target=>({target,observed_at:start,bot_user_id:'U123',bot_id:'B123',workspace_name:'Fixture Workspace',channel_name:'Fixture Channel',revision:{complete:true,items:[{message_ts:target.thread_ts,edited_ts:null,content_hmac_sha256:'a'.repeat(64)}]}}),
  send:async(target,text,_marker,_observation,before)=>{before();expect(target).toMatchObject({workspace_id:'tenant',channel_id:'C123',thread_ts:'1791080198.497089'});expect(text).toBe('外部承認のexact本文 <img src=x onerror=alert(1)>');sends++;return {outcome:'accepted',receipt_ref:'fixture_slack_receipt'};},reconcile:async()=>({outcome:'unknown'}),
 });f.setExternalApproval(service);
 const source=f.db.operatorAuth.pair(f.db.operatorAuth.issueCode(['approvals:external']).code),actor=f.db.operatorAuth.withSession(source.token,'approvals:external',a=>a);
 const created=await service.request(actor,{idempotency_key:'browser_external',workspace_id:'tenant',channel_id:'C123',thread_ts:'1791080198.497089',text:'外部承認のexact本文 <img src=x onerror=alert(1)>'});if(created.status==='denied')throw Error('fixture_denied');
 const proxy=https.createServer({cert:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-cert.pem',import.meta.url)),key:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-key.pem',import.meta.url))},(req,res)=>{
  const decision=req.method==='POST'&&req.url==='/api/approvals/decide';if(decision)decisions++;if(req.url?.endsWith('/status'))statusReads++;
  const upstream=http.request({hostname:'127.0.0.1',port:f.port,path:req.url,method:req.method,headers:req.headers},response=>{
   if(decision&&!dropped&&response.statusCode===200){dropped=true;response.resume();res.destroy();return;}
   res.writeHead(response.statusCode!,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end();}});req.pipe(upstream);
 });await new Promise<void>(r=>proxy.listen(port,'127.0.0.1',r));
 try{
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.setFixedTime(new Date(start));
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(origin);const issued=await f.request('/pair',{control:true,body:{capabilities:['approvals:external']}});expect(issued.status).toBe(200);
  await page.getByLabel('接続コード').fill(issued.body.code);await page.getByRole('button',{name:'この端末を接続する',exact:true}).click();
  await page.getByRole('button',{name:'承認用パスキーを登録'}).click();await expect(page.locator('#credential-status')).toContainText('登録済み');
  await page.locator(`[data-external="${created.request_handle}"]`).click();await expect(page.locator('#external-detail')).toContainText('Fixture Workspace');await expect(page.locator('#external-detail')).toContainText('Fixture Channel');
  for(const literal of ['tenant','C123','1791080198.497089','外部承認のexact本文 <img src=x onerror=alert(1)>'])await expect(page.locator('#external-detail')).toContainText(literal);await expect(page.locator('#external-detail img')).toHaveCount(0);
  await page.getByRole('button',{name:'この外部操作を許可'}).click();await expect(page.locator('#external-status')).toContainText('判断: 許可');await expect(page.locator('#external-status')).toContainText('実行成功は未確認');
  expect(dropped).toBe(true);expect(decisions).toBe(1);expect(statusReads).toBeGreaterThan(0);expect(sends).toBe(0);expect(service.status(actor,created.request_handle).decision?.kind).toBe('approve');
  await service.executePending();await service.executePending();expect(sends).toBe(1);
  await page.reload();await page.locator(`[data-external="${created.request_handle}"]`).click();await expect(page.locator('#external-detail')).toContainText('外部操作の履歴');await expect(page.locator('#external-status')).toContainText('実行: 実行成功');await expect(page.getByRole('button',{name:'この外部操作を許可'})).toHaveCount(0);
  expect(decisions).toBe(1);expect(sends).toBe(1);expect(errors).toEqual([]);
 }finally{await context.close();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));closeSecurity();await f.close();for(const close of cleanup.reverse())close();}
});
