import {expect,test} from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {operatorStackFixture} from '../../../dispatcher/test/operator-stack-fixture.js';
import {observerDashboardPage} from '../src/observer-dashboard.js';
async function freePort(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
test('実HTTPS browserから実Dispatcherへ依頼・取消・質問を送り、応答喪失はreceiptだけで回復する',async({browser})=>{
 const port=await freePort(),origin=`https://localhost:${port}`,f=await operatorStackFixture({origin,page:observerDashboardPage()}),context=await browser.newContext({ignoreHTTPSErrors:true});let posts=0,dropped=false;
 const proxy=https.createServer({cert:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-cert.pem',import.meta.url)),key:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-key.pem',import.meta.url))},(incoming,outgoing)=>{
  const submit=incoming.method==='POST'&&incoming.url==='/api/tasks';if(submit)posts++;
  const upstream=http.request({hostname:'127.0.0.1',port:f.port,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{
   // Dispatcherのcommit後、HTTPS応答だけを落とす。worker/APIの成功をfixtureで捏造しない。
   if(submit&&!dropped){dropped=true;response.resume();outgoing.destroy();return;}
   outgoing.writeHead(response.statusCode!,response.headers);response.pipe(outgoing);
  });upstream.on('error',()=>{if(!outgoing.destroyed){outgoing.writeHead(502);outgoing.end();}});incoming.pipe(upstream);
 });await new Promise<void>(r=>proxy.listen(port,'127.0.0.1',r));
 try {
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await expect(page.locator('#pairing')).toBeVisible();
  const issued=await f.request('/pair',{control:true,body:{capabilities:['tasks:read','tasks:submit','tasks:cancel']}});expect(issued.status).toBe(200);
  await page.getByLabel('接続コード').fill(issued.body.code);await page.getByRole('button',{name:'この端末を接続する',exact:true}).click();
  await page.getByLabel('Donaへの依頼').fill('ブラウザからの依頼');await page.getByRole('button',{name:'依頼する',exact:true}).click();
  await expect(page.locator('#command-status')).toContainText('依頼を受け付けました');expect(posts).toBe(1);expect(f.db.tasks.scanSnapshot()).toHaveLength(1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'このTaskを取り消す'}).click();await expect(page.locator('#command-status')).toContainText('取消を受け付けました');expect(f.db.tasks.scanSnapshot()[0]!.state).toBe('cancelled');
  await page.getByLabel('Donaへの依頼').fill('質問を必要とする依頼');await page.getByRole('button',{name:'依頼する',exact:true}).click();await expect(page.locator('#command-status')).toContainText('依頼を受け付けました');expect(posts).toBe(2);
  const active=f.db.tasks.scanSnapshot().find(task=>task.desired_state==='running')!;const pending=f.startQuestion(active.task_id,'question','browser_question');
  await page.getByRole('button',{name:'更新',exact:true}).click();await page.getByLabel('何を調べますか？').fill('workerの状態を確認');await page.getByRole('button',{name:'回答をDonaに送る'}).click();await expect(page.locator('#command-status')).toContainText('回答を受け付けました');
  expect(f.writes).toEqual([]);const reply=f.db.list().find(event=>event.event_type==='worker_question_reply')!;
  const delivered=await f.request(`/v1/tasks/${active.task_id}/answer`,{dispatcher:true,body:{source_event_id:reply.event_id,revision:pending.task.revision,question_id:pending.q.question_id,answers:{scope:{answers:['workerの状態を確認']}}}});expect(delivered.status).toBe(200);expect(f.writes).toEqual([{action:'answer',id:'browser_question'}]);
  expect(errors).toEqual([]);const cookies=await context.cookies(origin);expect(cookies[0]).toMatchObject({secure:true,httpOnly:true,sameSite:'Strict'});
 }finally{await context.close();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));await f.close();}
});
