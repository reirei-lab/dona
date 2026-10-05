import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';
import {readDashboardRelease,watchDashboardRelease} from '../src/dashboard/release-pointer.js';
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dona-observer-release-'))),pointer=path.join(root,'current');
 const release=(sha:string,web=true)=>{const dir=path.join(root,'releases',sha);for(const sub of ['dispatcher/dist/dashboard','sources/web/dist'])fs.mkdirSync(path.join(dir,sub),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(dir,'release-manifest.json'),JSON.stringify({sha,lock_hashes:web?{'sources/web':'b'.repeat(64)}:{}}));
 if(web){fs.writeFileSync(path.join(dir,'dispatcher/dist/dashboard/cli.js'),'');fs.writeFileSync(path.join(dir,'sources/web/dist/observer-dashboard.js'),'');}return dir;};
 const a=release('a'.repeat(40)),b=release('b'.repeat(40));fs.symlinkSync(a,pointer);
 const change=(target:string)=>{fs.symlinkSync(target,pointer+'.tmp');fs.renameSync(pointer+'.tmp',pointer);};
 return{root,pointer,a,b,release,change};
}
test('active pointerは同じruntimeのWeb対応releaseだけを受け入れる',()=>{
 const f=fixture();try{assert.equal(readDashboardRelease(f.pointer).root,f.a);f.change(f.b);assert.equal(readDashboardRelease(f.pointer).root,f.b);
 f.change(f.release('c'.repeat(40),false));assert.throws(()=>readDashboardRelease(f.pointer));f.change(f.a);fs.chmodSync(f.root,0o755);assert.throws(()=>readDashboardRelease(f.pointer));
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('preserve upgradeとrollbackはWebだけを停止しworkerを継続する',async()=>{
 const f=fixture(),worker=spawn(process.execPath,['-e',"setInterval(()=>process.stdout.write('alive\\n'),20)"],{stdio:['ignore','pipe','ignore']});
 let cancel=()=>{};
 try{
  await once(worker.stdout!,'data');
  for(const [expected,target]of [['a'.repeat(40),f.b],['b'.repeat(40),f.a]]as const){
   const web=http.createServer((_q,r)=>r.end('ready'));await new Promise<void>(r=>web.listen(0,'127.0.0.1',r));
   let calls=0;let stopped!:()=>void;const done=new Promise<void>(r=>stopped=r);
   cancel=watchDashboardRelease(f.pointer,expected,async()=>{calls++;await new Promise<void>(r=>web.close(()=>r()));stopped();},10);
   f.change(target);await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('watch_timeout')),2000))]);
   assert.equal(calls,1);assert.equal(web.listening,false);assert.equal(worker.exitCode,null);await once(worker.stdout!,'data');cancel();
  }
 }finally{cancel();worker.kill();await once(worker,'exit');fs.rmSync(f.root,{recursive:true,force:true});}
});
test('非対応rollback先でもWebを停止し、同じ停止を繰り返さない',async()=>{
 const f=fixture();let cancel=()=>{};
 try{let calls=0;let stopped!:()=>void;const done=new Promise<void>(r=>stopped=r);
 cancel=watchDashboardRelease(f.pointer,'a'.repeat(40),async()=>{calls++;stopped();},10);f.change(f.release('c'.repeat(40),false));
 await done;assert.equal(calls,1);cancel();
 }finally{cancel();fs.rmSync(f.root,{recursive:true,force:true});}
});
