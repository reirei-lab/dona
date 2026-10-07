import {expect,test} from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {operatorRuntimeFixture} from '../../../dispatcher/test/operator-runtime-fixture.js';
import {observerDashboardPage} from '../src/observer-dashboard.js';
async function freePort(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
test('browser依頼から実Dispatcher・Unix App Server subprocessの進捗・最終Resultまで到達する',async({browser})=>{
 // 1秒周期のRuntime復旧がinitialize待ちを観測する条件を作る。起動成功後に停止されてはいけない。
 test.setTimeout(60000);const port=await freePort(),origin=`https://localhost:${port}`,f=await operatorRuntimeFixture(origin,observerDashboardPage(),{initializeDelayMs:1100}),context=await browser.newContext({ignoreHTTPSErrors:true});let submits=0;const slow:http.IncomingMessage[]=[];
 const proxy=https.createServer({cert:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-cert.pem',import.meta.url)),key:await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-key.pem',import.meta.url))},(incoming,outgoing)=>{
  if(incoming.method==='POST'&&incoming.url==='/api/tasks')submits++;
  const upstream=http.request({hostname:'127.0.0.1',port:f.port,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{outgoing.writeHead(response.statusCode!,response.headers);response.pipe(outgoing);});upstream.on('error',()=>outgoing.destroy());incoming.pipe(upstream);
 });await new Promise<void>(r=>proxy.listen(port,'127.0.0.1',r));
 try{
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
  await page.getByLabel('接続コード').fill(await f.pairCode());await page.getByRole('button',{name:'この端末を接続する',exact:true}).click();
  await page.getByLabel('Donaへの依頼').fill('隔離プロトコルを実行して成果を返す');await page.getByRole('button',{name:'依頼する',exact:true}).click();await expect(page.locator('#command-status')).toContainText('依頼を受け付けました');
  await expect.poll(()=>{const task=f.db.tasks.scanSnapshot()[0];return task?f.db.getJob(task.current_attempt_id)?.status:null;},{timeout:15000}).toBe('running');
  await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('隔離ワーカーが実行中です',{timeout:10000});
  const task=f.db.tasks.scanSnapshot()[0]!;expect(task.current_attempt_id).toBeTruthy();expect(f.worker.isRunning()).toBe(true);expect(f.supervisor.isRunning()).toBe(true);
  const running=await f.client.list(),agent=running.find(a=>a.role==='worker')!;expect(agent.state).toBe('working');expect(agent.pid).toBeGreaterThan(0);
  const snapshot=await (await page.request.get(origin+'/api/tasks/'+task.task_id)).json();
  const cookie=(await context.cookies(origin)).map(c=>c.name+'='+c.value).join(';');
  // 受信を停止した複数clientにも有限frameだけを持ち、他の閲覧・完了を妨げない。
  for(let n=0;n<8;n++)slow.push(await new Promise<http.IncomingMessage>((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:f.port,path:'/api/tasks/'+task.task_id+'/events',headers:{host:new URL(origin).host,cookie,'last-event-id':snapshot.stream_cursor}},res=>{res.pause();resolve(res);});req.on('error',reject);}));
  for(const response of slow){expect(response.statusCode).toBe(200);expect(Number(response.headers['content-length'])).toBeLessThan(1024);expect(response.headers['content-type']).toContain('text/event-stream');}
  const callsBefore=await f.calls();for(let n=0;n<3;n++)await page.getByRole('button',{name:'更新',exact:true}).click();
  expect((await f.calls()).filter(c=>c.method==='turn/start')).toHaveLength(callsBefore.filter(c=>c.method==='turn/start').length);
  await f.finish();await expect.poll(()=>({state:f.db.tasks.get(task.task_id)?.state,job:f.db.getJob(task.current_attempt_id)?.status,error:f.db.getJob(task.current_attempt_id)?.last_error_code}),{timeout:15000}).toEqual({state:'completed',job:'completed',error:null});
  await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#detail')).toContainText('保存された最終成果',{timeout:10000});await expect(page.locator('#detail')).toContainText('隔離ワーカーが完了しました');
  expect(submits).toBe(1);expect(f.db.tasks.attempts(task.task_id)).toHaveLength(1);expect(f.db.getJob(task.current_attempt_id)?.status).toBe('completed');
  const calls=await f.calls();expect(calls.filter(c=>c.method==='thread/start')).toHaveLength(2);expect(calls.filter(c=>c.method==='turn/start'&&c.pid===agent.pid)).toHaveLength(1);expect(calls.some(c=>c.method==='thread/read')).toBe(true);expect(calls.some(c=>c.method==='thread/turns/list')).toBe(true);expect(errors).toEqual([]);
 }catch(error){
  try{console.error('operator runtime diagnostics:',JSON.stringify(await f.diagnostics()));}catch(diagnosticError){console.error('operator runtime diagnostics unavailable:',diagnosticError);}
  throw error;
 }finally{for(const response of slow)response.destroy();await context.close();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));await f.close();}
});
