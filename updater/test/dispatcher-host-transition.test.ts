import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DispatcherHostTransition} from '../src/dispatcher-host-transition.js';
import {tempPolicy,currentSha,targetSha,removeTree} from './helpers.js';
const codec={decode:(b:Buffer)=>JSON.parse(b.toString()),encode:(v:Record<string,unknown>)=>Buffer.from(JSON.stringify(v))};
async function fixture(){
 const f=await tempPolicy();await fs.mkdir(f.policy.control_root,{recursive:true,mode:0o700});
 f.policy.signed_host={team_id:'ABCDEFGHIJ',access_group:'ABCDEFGHIJ.dev.dona.approval',signing_identity_sha1:'a'.repeat(40),provisioning_profile:'/fixture/profile'};
 const file=path.join(f.root,'dispatcher.plist');
 const old=Buffer.from(JSON.stringify({Label:'dev.dona.dispatcher',ProgramArguments:[f.policy.executables.node,path.join(f.policy.current_pointer,'dispatcher/dist/cli.js'),'serve'],EnvironmentVariables:{DONA_SENTINEL:'preserved',DONA_LOCAL_APPROVAL_CONFIG:'/private/approval.json'},KeepAlive:true}));
 await fs.writeFile(file,old,{mode:0o600});const transition=new DispatcherHostTransition(f.policy,file,codec);
 const digest=transition.plan(currentSha,targetSha)!;return {...f,file,old,transition,t:{digest,from_sha:currentSha,to_sha:targetSha}};
}
test('初回host切替はexact plistをplanに束縛して停止中だけ変更し旧内容を復元',async()=>{
 const f=await fixture();try{
 assert.match(f.t.digest,/^[a-f0-9]{64}$/);assert.equal(f.transition.plan(currentSha,targetSha),f.t.digest);
 assert.throws(()=>f.transition.apply(f.t,'target',true),/live_or_drift/);assert.deepEqual(await fs.readFile(f.file),f.old);
 f.transition.apply(f.t,'target',false);const next=JSON.parse(await fs.readFile(f.file,'utf8'));
 assert.deepEqual(next.ProgramArguments,[path.join(f.policy.current_pointer,'signed-host/DonaDispatcher.app/Contents/MacOS/DonaDispatcher'),'serve']);assert.deepEqual(next.EnvironmentVariables,{DONA_SENTINEL:'preserved',DONA_LOCAL_APPROVAL_CONFIG:'/private/approval.json'});
 f.transition.apply(f.t,'target',true);assert.throws(()=>f.transition.apply(f.t,'original',true));
 f.transition.apply(f.t,'original',false);assert.deepEqual(await fs.readFile(f.file),f.old);f.transition.verifyOriginal(f.t);
 assert.equal((await fs.stat(f.file)).mode&0o777,0o600);
 }finally{await removeTree(f.root);}
});
test('承認後plist driftとsnapshot/target差替えを拒否し一時ファイル残存に依存しない',async()=>{
 const f=await fixture();try{
 const dir=path.join(f.policy.control_root,'dispatcher-host-transitions');await fs.writeFile(path.join(dir,'orphan.tmp'),'interrupted');
 assert.equal(f.transition.plan(currentSha,targetSha),f.t.digest);
 await fs.writeFile(f.file,JSON.stringify({...JSON.parse(f.old.toString()),KeepAlive:false}));
 assert.throws(()=>f.transition.verifyOriginal(f.t),/drift/);assert.throws(()=>f.transition.apply(f.t,'target',false),/drift/);
 await fs.writeFile(f.file,f.old);assert.throws(()=>f.transition.apply({...f.t,to_sha:'d'.repeat(40)},'target',false),/scope/);
 await fs.writeFile(path.join(dir,f.t.digest+'.json'),'corrupt');assert.throws(()=>f.transition.apply(f.t,'target',false),/snapshot/);
 }finally{await removeTree(f.root);}
});
test('非regularまたはhardlinkのLaunchAgentは初回plan対象外',async()=>{
 const f=await fixture();try{await fs.link(f.file,f.file+'.alias');assert.throws(()=>f.transition.plan(currentSha,targetSha),/file_invalid/);await fs.unlink(f.file+'.alias');await fs.rename(f.file,f.file+'.original');await fs.symlink(f.file+'.original',f.file);assert.throws(()=>f.transition.plan(currentSha,targetSha));}finally{await removeTree(f.root);}
});

test('外部承認設定pathの変更も初回plan driftとして拒否する',async()=>{
 const f=await fixture();try{const changed=JSON.parse(f.old.toString());changed.EnvironmentVariables.DONA_LOCAL_APPROVAL_CONFIG='/private/replacement.json';await fs.writeFile(f.file,JSON.stringify(changed));assert.throws(()=>f.transition.verifyOriginal(f.t),/drift/);assert.throws(()=>f.transition.apply(f.t,'target',false),/drift/);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).EnvironmentVariables.DONA_LOCAL_APPROVAL_CONFIG,'/private/replacement.json');}finally{await removeTree(f.root);}
});
