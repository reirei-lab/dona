import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {writeDashboardPlist} from '../scripts/dashboard-plist.mjs';

test('旧installのtemporaryが残っていても新plistを原子的に配置する',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dona-plist-')),file=path.join(root,'dev.dona.dashboard.plist');
 try {
  fs.writeFileSync(file,'old',{mode:0o600});
  fs.writeFileSync(file+'.tmp','interrupted old fixed-name write',{mode:0o600});
  fs.writeFileSync(file+'.old-generation.tmp','interrupted unique-name write',{mode:0o600});
  writeDashboardPlist(file,'new');
  assert.equal(fs.readFileSync(file,'utf8'),'new');assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(fs.readFileSync(file+'.tmp','utf8'),'interrupted old fixed-name write');
  assert.equal(fs.readFileSync(file+'.old-generation.tmp','utf8'),'interrupted unique-name write');
  assert.deepEqual(fs.readdirSync(root).sort(),[path.basename(file),path.basename(file)+'.old-generation.tmp',path.basename(file)+'.tmp'].sort());
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('rename失敗時は旧plistを保持し、自分のtemporaryだけを片付けて次回成功できる',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dona-plist-failure-')),file=path.join(root,'dev.dona.dashboard.plist'),rename=fs.renameSync;
 try {
  fs.writeFileSync(file,'old',{mode:0o600});fs.writeFileSync(file+'.tmp','unrelated stale temporary',{mode:0o600});
  fs.renameSync=()=>{throw Object.assign(Error('injected rename failure'),{code:'EIO'});};
  assert.throws(()=>writeDashboardPlist(file,'new'),/injected rename failure/);
  assert.equal(fs.readFileSync(file,'utf8'),'old');
  assert.deepEqual(fs.readdirSync(root).sort(),[path.basename(file),path.basename(file)+'.tmp'].sort());
  fs.renameSync=rename;writeDashboardPlist(file,'new');assert.equal(fs.readFileSync(file,'utf8'),'new');
 } finally { fs.renameSync=rename;fs.rmSync(root,{recursive:true,force:true}); }
});
