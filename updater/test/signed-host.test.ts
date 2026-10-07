import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {CanonicalBuild,RealRuntime} from '../src/adapters.js';import {ProcessRunner,type RunOptions} from '../src/process.js';import {parsePolicy,signedHostPolicyDigest} from '../src/policy.js';import {tempPolicy,manifest,currentSha,removeTree} from './helpers.js';
const ok={exit_code:0,stdout:'',stderr:'',timed_out:false,output_truncated:false};
async function fixture(){const f=await tempPolicy();await fs.mkdir(f.policy.control_root,{recursive:true});const profile=path.join(f.root,'profile');await fs.writeFile(profile,'fixture');f.policy.signed_host={team_id:'ABCDEFGHIJ',access_group:'ABCDEFGHIJ.dev.dona.approval',signing_identity_sha1:'a'.repeat(40),provisioning_profile:profile};return f;}
test('signed policyはunknown fieldとidentityを拒否しprofile内容をdigestへ束縛',async()=>{const f=await fixture();try{assert.deepEqual(parsePolicy(f.policy).signed_host,f.policy.signed_host);const d=signedHostPolicyDigest(f.policy);await fs.writeFile(f.policy.signed_host!.provisioning_profile,'changed');assert.notEqual(signedHostPolicyDigest(f.policy),d);assert.throws(()=>parsePolicy({...f.policy,signed_host:{...f.policy.signed_host,command:'/tmp/evil'}}));}finally{await removeTree(f.root);}});
test('prepareはprivate一時設定で署名工程→doctorを実行しstale名へ依存しない',async()=>{
 const f=await fixture();const calls:string[]=[];try{
 const release=path.join(f.root,'stage');await fs.mkdir(release);await fs.writeFile(path.join(f.policy.control_root,'signed-host-build.json'),'stale');
 const runner={run:async(_exe:string,args:readonly string[],_options:RunOptions)=>{calls.push(args[0]!);if(args[0]!.endsWith('prepare-signed-dispatcher-host.mjs')){
 assert.deepEqual(JSON.parse(await fs.readFile(args[2]!,'utf8')),f.policy.signed_host);assert.equal((await fs.stat(args[2]!)).mode&0o077,0);
 const resources=path.join(release,'signed-host/DonaDispatcher.app/Contents/Resources');await fs.mkdir(resources,{recursive:true});await fs.writeFile(path.join(resources,'host-contract.json'),JSON.stringify({release_sha:currentSha}));return ok;}
 return {...ok,stdout:JSON.stringify({activation_allowed:true})};}};
 await new CanonicalBuild(f.policy,runner as unknown as ProcessRunner).prepareSignedHost(release,manifest(currentSha));
 assert.equal(calls.length,2);assert.ok(calls[0]!.endsWith('prepare-signed-dispatcher-host.mjs'));assert.ok(calls[1]!.endsWith('doctor-dispatcher-host.mjs'));
 assert.deepEqual((await fs.readdir(f.policy.control_root)).filter(x=>x.startsWith('signed-host-build-')),[]);
 }finally{await removeTree(f.root);}
});
test('start/rollbackはdoctor未確認または旧Node plistならlaunchctlへ進まない',async()=>{
 const f=await fixture();try{
 const release=path.join(f.policy.release_root,currentSha),resources=path.join(release,'signed-host/DonaDispatcher.app/Contents/Resources');await fs.mkdir(resources,{recursive:true});await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify(manifest(currentSha)));await fs.writeFile(path.join(resources,'host-contract.json'),JSON.stringify({release_sha:currentSha}));await fs.symlink(release,f.policy.current_pointer);
 const calls:string[]=[];let doctor=false;const runner={run:async(exe:string,args:readonly string[])=>{calls.push(exe);return {...ok,stdout:exe==='/usr/bin/plutil'?JSON.stringify(['/usr/bin/node','old.js','serve']):JSON.stringify({activation_allowed:doctor})};}};
 const runtime=new RealRuntime(f.policy,runner as unknown as ProcessRunner);await assert.rejects(runtime.startDispatcher(),/signed_host_unverified/);doctor=true;await assert.rejects(runtime.startDispatcher(),/signed_host_launchd_mismatch/);assert.equal(calls.includes(f.policy.executables.launchctl),false);
 }finally{await removeTree(f.root);}
});
