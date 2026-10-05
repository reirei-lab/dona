import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {profileContract,copyTree,plist} from '../scripts/dispatcher-host-artifact.mjs';
const team='ABCDEFGHIJ',group=team+'.dev.dona.approval';
const profile=()=>({Platform:['OSX'],TeamIdentifier:[team],ApplicationIdentifierPrefix:[team],ExpirationDate:'2099-01-01T00:00:00Z',ProvisionsAllDevices:true,Entitlements:{'com.apple.developer.team-identifier':team,'com.apple.application-identifier':team+'.dev.dona.dispatcher.host','keychain-access-groups':[team+'.*']}});
test('Developer ID profileはexact App ID/Team/groupへ狭める',()=>{const e=profileContract(profile(),team,group);assert.deepEqual(e['keychain-access-groups'],[group]);assert.equal(e['com.apple.security.cs.allow-jit'],true);});
test('期限切れ/異なるidentity/group/platform/development/debug profileを拒否',()=>{for(const change of [p=>p.ExpirationDate='2020-01-01',p=>p.Platform=['iOS'],p=>p.ProvisionsAllDevices=false,p=>p.TeamIdentifier=['ZZZZZZZZZZ'],p=>p.Entitlements['com.apple.application-identifier']=team+'.*',p=>p.Entitlements['keychain-access-groups']=['ZZZZZZZZZZ.*'],p=>p.Entitlements['com.apple.security.get-task-allow']=true]){const p=profile();change(p);assert.throws(()=>profileContract(p,team,group));}assert.throws(()=>profileContract(profile(),team+'" or true',group));});
test('AppIdentifierPrefixとTeamを混同しない',()=>{const p=profile();p.ApplicationIdentifierPrefix=['KLMNOPQRST'];p.Entitlements['com.apple.application-identifier']='KLMNOPQRST.dev.dona.dispatcher.host';p.Entitlements['keychain-access-groups']=['KLMNOPQRST.*'];assert.deepEqual(profileContract(p,team,'KLMNOPQRST.dev.dona.approval')['keychain-access-groups'],['KLMNOPQRST.dev.dona.approval']);});
test('resource copyは外部symlinkとhardlinkを拒否しnpm bin linkを除外',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'dona-host-'));try{const s=path.join(d,'source');fs.mkdirSync(s);fs.writeFileSync(path.join(s,'ok'),'x');fs.mkdirSync(path.join(s,'.bin'));fs.symlinkSync('/tmp',path.join(s,'.bin/ignored'));copyTree(s,path.join(d,'ok'));assert.equal(fs.existsSync(path.join(d,'ok/.bin')),false);fs.symlinkSync('/tmp',path.join(s,'bad'));assert.throws(()=>copyTree(s,path.join(d,'bad')));fs.unlinkSync(path.join(s,'bad'));fs.linkSync(path.join(s,'ok'),path.join(s,'link'));assert.throws(()=>copyTree(s,path.join(d,'hard')));}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('unsigned/missing bundle doctorはreadyを返さない',()=>{const r=spawnSync(process.execPath,['scripts/doctor-dispatcher-host.mjs','/nonexistent/DonaDispatcher.app',team,group],{encoding:'utf8'});assert.equal(r.status,1);const value=JSON.parse(r.stdout);assert.equal(value.activation_allowed,false);assert.equal(value.protected_state,'not_checked');});
test('plist escapes text without changing entitlement structure',()=>{const p=plist({value:'a<&b',enabled:true,groups:['one']});assert.match(p,/a&lt;&amp;b/);assert.match(p,/<true\/>/);});
test('固定bootstrapはESM/CJSのbundle外moduleとdata URLを拒否する',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'dona-host-loader-'));try{
  const contents=path.join(d,'Contents'),release=path.join(contents,'Resources/release');fs.mkdirSync(release,{recursive:true});
  const binary=path.join(contents,'MacOS/DonaDispatcher'),entry=path.join(release,'entry.cjs');
  const bootstrap=fs.readFileSync(new URL('../native/dispatcher-host/bootstrap.inc',import.meta.url),'utf8').split('R"DONAJS(\n')[1].split(')DONAJS";')[0];
  const execute=source=>{fs.writeFileSync(entry,source);return spawnSync(process.execPath,['-e',`Object.defineProperty(process,'execPath',{value:${JSON.stringify(binary)}});process.argv=['host',${JSON.stringify(entry)}];${bootstrap}`],{encoding:'utf8'});};
  fs.writeFileSync(path.join(release,'ok.cjs'),'module.exports = "inside"');let r=execute('console.log(require("./ok.cjs"))');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/inside/);
  fs.writeFileSync(path.join(d,'outside.cjs'),'console.log("FORBIDDEN")');r=execute(`require(${JSON.stringify(path.join(d,'outside.cjs'))})`);assert.equal(r.status,1);assert.doesNotMatch(r.stdout,/FORBIDDEN/);
  r=execute('import("data:text/javascript,console.log(123)").catch(()=>{process.exitCode=1})');assert.equal(r.status,1);assert.doesNotMatch(r.stdout,/123/);
  fs.symlinkSync(path.join(d,'outside.cjs'),path.join(release,'escape.cjs'));r=execute('require("./escape.cjs")');assert.equal(r.status,1);assert.doesNotMatch(r.stdout,/FORBIDDEN/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('release Node majorをhost pinと照合し、欠落/異なるmajorを拒否する',async()=>{
 const {assertHostNodeMajor,assertNativeDoctor}=await import('../scripts/dispatcher-host-artifact.mjs');
 assert.doesNotThrow(()=>assertHostNodeMajor('24.4.0','24.21.0'));
 for(const version of ['22.20.0','25.0.0',undefined,'24','24.4.0-extra'])assert.throws(()=>assertHostNodeMajor(version,'24.21.0'));
 assert.doesNotThrow(()=>assertNativeDoctor({native:'verified',sqlite:'loaded',keytar:'loaded'}));
 for(const result of [{signature:'verified'},null,{native:'verified',sqlite:'loaded'},{native:'verified',sqlite:'loaded',keytar:'failed'}])assert.throws(()=>assertNativeDoctor(result));
});

test('固定native smokeはmemory DBとkeytarロードだけを行い、nativeロード失敗を拒否する',async()=>{
 const {stripTypeScriptTypes}=await import('node:module');
 const source=stripTypeScriptTypes(fs.readFileSync(new URL('../dispatcher/src/host-native-doctor.ts',import.meta.url),'utf8'));
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'dona-host-native-smoke-'));
 try{
  const entry=path.join(d,'dispatcher/dist/host-native-doctor.mjs');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,source);
  const sqlite=path.join(d,'dispatcher/node_modules/better-sqlite3');fs.mkdirSync(sqlite,{recursive:true});
  fs.writeFileSync(path.join(sqlite,'package.json'),JSON.stringify({main:'index.cjs'}));
  fs.writeFileSync(path.join(sqlite,'index.cjs'),`module.exports=class {constructor(p){if(p!==':memory:')throw Error('file_access');} prepare(q){if(q!=='SELECT 1')throw Error('mutation');return {pluck:()=>({get:()=>1})};}close(){}};`);
  const keytar=path.join(d,'sources/slack/node_modules/@github/keytar');fs.mkdirSync(keytar,{recursive:true});
  fs.writeFileSync(path.join(keytar,'package.json'),JSON.stringify({main:'index.cjs'}));
  fs.writeFileSync(path.join(keytar,'index.cjs'),`module.exports={getPassword(){throw Error('keychain_access_forbidden')}};`);
  const run=(args=[])=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8'});
  let r=run();assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{native:'verified',sqlite:'loaded',keytar:'loaded'});
  r=run(['arbitrary.js']);assert.equal(r.status,1);assert.equal(r.stdout,'');
  fs.writeFileSync(path.join(keytar,'index.cjs'),`throw Error('native_load_failure')`);r=run();assert.equal(r.status,1);assert.equal(r.stdout,'');
  fs.writeFileSync(path.join(sqlite,'index.cjs'),`throw Error('NODE_MODULE_VERSION mismatch')`);r=run();assert.equal(r.status,1);assert.equal(r.stdout,'');
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
