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
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'local-key-config-'))),file=path.join(root,'config.json');
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
