import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNativeApprovalArguments} from '../src/approval/local-native-cli.js';
test('native承認CLIは固定modeと正規絶対pathだけを受理する',()=>{
 assert.deepEqual(parseNativeApprovalArguments(['doctor','--config','/private/config.json','--database','/private/state.sqlite']),{action:'doctor',config:'/private/config.json',database:'/private/state.sqlite'});
 for(const args of [[],['eval','--config','/a','--database','/b'],['doctor','--config','relative','--database','/b'],['doctor','--config','/a','--database','/b','--config','/c'],['doctor','--config','/a','--database','/b','--exec','/c'],['doctor','--config','/a/../b','--database','/b']])assert.throws(()=>parseNativeApprovalArguments(args),/invalid_arguments/);
});

test('rotation設定は旧内容を照合して原子的に保存し競合では変更しない',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {replaceNativeApprovalConfig}=await import('../src/approval/local-native-cli.js');
 const root=await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.homedir()),'.dona-local-key-config-'))),file=path.join(root,'config.json');
 const old={codec_version:1 as const,scope:{instance_id:'instance',workspace_id:'T123'},owner_id:'owner',ledger_id:'ledger',access_group:'ABCDEFGHIJ.dev.dona.approval',used_nodes_database:path.join(root,'used.sqlite'),slack_workspace_alias:'work',key_version:1};
 try{
  await fs.writeFile(file,JSON.stringify(old),{mode:0o600});const next={...old,key_version:2};replaceNativeApprovalConfig(file,old,next);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),next);assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.throws(()=>replaceNativeApprovalConfig(file,old,{...old,key_version:3}),/config_changed/);
  assert.deepEqual(await fs.readdir(root),['config.json']);
  assert.equal(parseNativeApprovalArguments(['rotate','--config',file,'--database',path.join(root,'db'),'--next-version','2']).nextVersion,2);
  assert.throws(()=>parseNativeApprovalArguments(['doctor','--config',file,'--database',path.join(root,'db'),'--next-version','2']));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('native設定はfileが0600でも書込み可能な祖先を拒否する',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {readLocalApprovalNativeConfig}=await import('../src/approval/local-native.js');
 const {replaceNativeApprovalConfig}=await import('../src/approval/local-native-cli.js');
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.homedir()),'.dona-config-ancestor-'));
 const directory=path.join(root,'private'),file=path.join(directory,'config.json');
 const config={codec_version:1 as const,scope:{instance_id:'instance',workspace_id:'T123'},owner_id:'owner',ledger_id:'ledger',access_group:'ABCDEFGHIJ.dev.dona.approval',used_nodes_database:path.join(directory,'used.sqlite'),slack_workspace_alias:'work',key_version:1};
 try{
  await fs.mkdir(directory,{mode:0o700});const original=JSON.stringify(config);await fs.writeFile(file,original,{mode:0o600});
  assert.deepEqual(readLocalApprovalNativeConfig(file),config);
  for(const mode of [0o720,0o702,0o1777]){
   await fs.chmod(root,mode);
   assert.throws(()=>readLocalApprovalNativeConfig(file),/local_approval_config_unavailable/);
   assert.throws(()=>replaceNativeApprovalConfig(file,config,{...config,key_version:2}),/local_approval_config_unavailable/);
   assert.equal(await fs.readFile(file,'utf8'),original);
  }
  await fs.chmod(root,0o700);assert.deepEqual(readLocalApprovalNativeConfig(file),config);
 }finally{await fs.chmod(root,0o700);await fs.rm(root,{recursive:true,force:true});}
});
