import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {inspectDashboardInstallation} from '../scripts/dashboard-doctor.mjs';
test('doctorはprivate資源とTailscale導入不足を報告し変更しない',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dobs-doctor-')));fs.chmodSync(root,0o700);const socket=path.join(root,'d.sock'),database=path.join(root,'d.sqlite3');fs.writeFileSync(database,'fixture',{mode:0o600});
 const server=net.createServer();try{
  await new Promise(r=>server.listen(socket,r));fs.chmodSync(socket,0o600);const config={dispatcher_socket:socket,runtime_socket:socket,dispatcher_database:database,control_socket:path.join(root,'c.sock')};
  const before=fs.readdirSync(root);assert.equal(inspectDashboardInstallation(config,root,()=> 'ok').ready,true);
  const absent=inspectDashboardInstallation(config,root,()=> 'not_installed');assert.equal(absent.ready,false);assert.equal(absent.checks.at(-1).status,'not_installed');
  fs.chmodSync(socket,0o666);const unsafe=inspectDashboardInstallation(config,root,()=> 'ok');assert.equal(unsafe.checks.find(c=>c.name==='dispatcher_socket').status,'error');
  assert.deepEqual(fs.readdirSync(root),before);assert.equal(fs.readFileSync(database,'utf8'),'fixture');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
