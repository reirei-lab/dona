import {expect,test} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {DispatcherDatabase} from '../../../dispatcher/src/database.js';
import {taskRequestSchema} from '../../../dispatcher/src/task-execution.js';
import {eventEnvelope} from '../../../dispatcher/test/helpers.js';
import {DashboardServer} from '../../../dispatcher/src/dashboard/server.js';
import {DashboardTaskReader} from '../../../dispatcher/src/dashboard/task-reader.js';
import {DashboardObserver,type ObservedConversation} from '../../../dispatcher/src/dashboard/observer.js';
import {observerDashboardPage} from '../src/observer-dashboard.js';
async function freePort(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address()as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
async function control(socketPath:string,route:string):Promise<Record<string,unknown>>{
 return new Promise((resolve,reject)=>{const req=http.request({socketPath,path:route,method:'POST',headers:{'content-length':'0'}},res=>{
  let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>res.statusCode===200?resolve(JSON.parse(body)):reject(Error('control_failed')));
 });req.on('error',reject);req.end();});
}
test('実HTTPS proxyとSecure cookieで観測し、別Originと失効後の閲覧を拒否する',async({browser})=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dobs-browser-'))),database=path.join(root,'d.sqlite3'),socket=path.join(root,'c.sock');
 const db=new DispatcherDatabase(database);let reader:DashboardTaskReader|undefined,server:DashboardServer|undefined,proxy:https.Server|undefined;
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 try{
  const event=db.enqueue(eventEnvelope('browser-proxy-observation')).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'browser-observation',objective:'private objective',workspace:{kind:'scratch'}}),path.join(root,'work'),path.join(root,'results')).task;
  const name=db.getJob(task.current_attempt_id)!.agent_name;
  db.beginJobPreparation(task.current_attempt_id);db.setJobRuntime(task.current_attempt_id,'workspace','pane',JSON.stringify(['fixture_generation','thread_one']));
  const before=JSON.stringify(db.tasks.get(task.task_id));
  reader=new DashboardTaskReader(database);
  const runtimeCalls:string[]=[],record:ObservedConversation={name,generation:'fixture_generation',role:'worker',thread_id:'thread_one',attempt_id:task.current_attempt_id,connected:true,observed_at:new Date().toISOString(),state:'working'};
  const observer=new DashboardObserver(reader,{conversations:async()=>{runtimeCalls.push('conversations');return{items:[record],next:null};},conversation:async()=>{runtimeCalls.push('conversation');return{...record,items:[{id:'item_one',turn_id:'turn_one',kind:'assistant_message',text:'HTTPS経由のワーカー進捗 <img src=x onerror=alert(1)>'}],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};}});
  const backend=await freePort(),publicPort=await freePort(),origin=`https://localhost:${publicPort}`;
  server=new DashboardServer({origin,port:backend,controlSocket:socket,version:'a'.repeat(40),reader,observer,page:observerDashboardPage()});await server.start();
  const cert=await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-cert.pem',import.meta.url));
  const key=await fs.readFile(new URL('../../../test-fixtures/tls/loopback-fixture-key.pem',import.meta.url));
  // Fixture TLS termination preserves the incoming Host like Tailscale Serve.
  // It makes no identity assertions and forwards no service credential.
  proxy=https.createServer({cert,key},(incoming,outgoing)=>{
   const upstream=http.request({hostname:'127.0.0.1',port:backend,path:incoming.url,method:incoming.method,headers:incoming.headers},response=>{
    outgoing.writeHead(response.statusCode!,response.headers);response.pipe(outgoing);
   });upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(upstream);
  });await new Promise<void>(r=>proxy!.listen(publicPort,'127.0.0.1',r));
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await expect(page.locator('#pairing')).toBeVisible();await expect(page.locator('#tasks')).toBeEmpty();
  const issued=await control(socket,'/pair');await page.getByLabel('接続コード').fill(String(issued.code));await page.getByRole('button',{name:'閲覧用に接続する'}).click();
  await page.getByRole('button',{name:/browser-observation/}).click();await expect(page.locator('#detail')).toContainText('HTTPS経由のワーカー進捗');
  await expect(page.locator('#detail img')).toHaveCount(0);expect(runtimeCalls).toEqual(['conversations','conversation']);
  const cookies=await context.cookies(origin);expect(cookies).toHaveLength(1);expect(cookies[0]).toMatchObject({name:'__Host-dona-observer',secure:true,httpOnly:true,sameSite:'Strict'});
  const session=await context.request.get(origin+'/api/session');expect(session.status()).toBe(200);
  const csrf=(await session.json()as{csrf:string}).csrf;
  const denied=await context.request.post(origin+'/api/logout',{headers:{origin:'https://attacker.example','x-csrf-token':csrf}});expect(denied.status()).toBe(403);
  expect((await context.request.get(origin+'/api/session')).status()).toBe(200);
  await control(socket,'/revoke');await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.locator('#pairing')).toBeVisible();
  await expect(page.locator('#tasks')).toBeEmpty();await expect(page.locator('#detail')).not.toContainText('HTTPS経由のワーカー進捗');
  expect(JSON.stringify(db.tasks.get(task.task_id))).toBe(before);expect(errors).toEqual([]);
 }finally{await context.close();if(proxy){proxy.closeAllConnections();await new Promise<void>(r=>proxy!.close(()=>r()));}await server?.close();reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
