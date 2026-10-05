import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
test('observer service renderは専用Webだけを指定し既存serviceを操作しない',{skip:process.platform!=='darwin'},()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dona-web-render-')));
 try{
 const release=path.join(root,'release'),control=path.join(root,'control'),logs=path.join(root,'logs');
 for(const file of [release,control,logs,path.join(release,'dispatcher/dist/dashboard')])fs.mkdirSync(file,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(release,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(release,'release-manifest.json'),JSON.stringify({sha:'a'.repeat(40),lock_hashes:{'sources/web':'b'.repeat(64)}}));
 fs.writeFileSync(path.join(release,'dispatcher/dist/dashboard/config.js'),`export function readDashboardConfig(){return {dispatcher_socket:'/fixture/dispatcher.sock',control_socket:${JSON.stringify(path.join(control,'c.sock'))}}}`);
 const result=spawnSync(process.execPath,[new URL('../scripts/dashboard-service.mjs',import.meta.url).pathname,'render',release,path.join(root,'config.json'),logs],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/dev\.dona\.dashboard/);assert.match(result.stdout,/<string>serve<\/string>/);assert.doesNotMatch(result.stdout,/dev\.dona\.(dispatcher|updater|slack)/);
 assert.match(result.stdout,/dispatcher\/dist\/dashboard\/cli\.js/);assert.doesNotMatch(result.stdout,/__[A-Z_]+__/);
 fs.writeFileSync(path.join(release,'dispatcher/dist/dashboard/config.js'),`export function readDashboardConfig(){return {control_socket:${JSON.stringify(path.join(control,'c.sock'))}}}`);
 const missing=spawnSync(process.execPath,[new URL('../scripts/dashboard-service.mjs',import.meta.url).pathname,'render',release,path.join(root,'config.json'),logs],{encoding:'utf8'});assert.equal(missing.status,1);assert.match(missing.stderr,/dashboard_dispatcher_socket_required/);
 const pointer=path.join(root,'current');fs.symlinkSync(release,pointer);
 fs.writeFileSync(path.join(release,'dispatcher/dist/dashboard/config.js'),`export function readDashboardConfig(){return {dispatcher_socket:'/fixture/dispatcher.sock',control_socket:${JSON.stringify(path.join(control,'c.sock'))},active_release_pointer:${JSON.stringify(pointer)}}}`);
 fs.writeFileSync(path.join(release,'dispatcher/dist/dashboard/release-pointer.js'),`export function readDashboardRelease(){return {root:${JSON.stringify(release)},sha:'${'a'.repeat(40)}'}}`);
 const tracked=spawnSync(process.execPath,[new URL('../scripts/dashboard-service.mjs',import.meta.url).pathname,'render',release,path.join(root,'config.json'),logs],{encoding:'utf8'});
 assert.equal(tracked.status,0,tracked.stderr);assert.ok(tracked.stdout.includes(pointer+'/dispatcher/dist/dashboard/cli.js'));
 assert.ok(tracked.stdout.includes('<key>WorkingDirectory</key><string>'+pointer+'</string>'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
