import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DashboardOperatorClient} from '../src/dashboard/operator-client.js';
import {OperatorFixture} from './dashboard-operator-fixture.js';
test('Dispatcher clientはprivate UDSと固定admin/session routeだけを使用する',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dobs-client-'))),socket=path.join(root,'d.sock'),backend=new OperatorFixture();await fs.chmod(root,0o700);
 const routes:string[]=[];const server=http.createServer(async(req,res)=>{try{routes.push(req.url!);let raw='';for await(const chunk of req)raw+=String(chunk);res.end(JSON.stringify(await backend.call(req.url!.replace('/v1/dashboard/',''),JSON.parse(raw))));}catch{res.writeHead(403);res.end('{}');}});
 try{
  await new Promise<void>(r=>server.listen(socket,r));await fs.chmod(socket,0o600);const client=new DashboardOperatorClient(socket);
  await client.call('admin/reset',{origin:'https://observer.example'});const issued=await client.call<{code:string}>('admin/pair',{capabilities:['tasks:read']});
  const paired=await client.call<{token:string}>('pair',{code:issued.code});assert.ok(paired.token);await client.call('session',{token:paired.token});
  await assert.rejects(client.call('../admin/reset',{}));assert.equal(routes.length,4);
  await fs.chmod(socket,0o666);await assert.rejects(client.call('admin/status',{}));assert.equal(routes.length,4);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});
