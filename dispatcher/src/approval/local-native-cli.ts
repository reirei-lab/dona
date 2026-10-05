#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {openSecurityDatabase} from '../audit/coordination.js';
import {NativeLocalApprovalConnection,readLocalApprovalNativeConfig,provisionNativeLocalApproval,rotateNativeLocalApproval,recoverNativeLocalApproval,type LocalApprovalNativeConfig} from './local-native.js';

export function parseNativeApprovalArguments(args:string[]){
 const action=args[0];if(!['doctor','provision','rotate','recover'].includes(action??''))throw Error('invalid_arguments');
 const values:Record<string,string>={};
 for(let i=1;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!name||!['--config','--database','--next-version'].includes(name)||!value||values[name]||(name==='--next-version'?!/^[1-9][0-9]*$/.test(value):!path.isAbsolute(value)||path.normalize(value)!==value))throw Error('invalid_arguments');values[name]=value;}
 if(!values['--config']||!values['--database'])throw Error('invalid_arguments');
 if((action==='rotate')!==!!values['--next-version'])throw Error('invalid_arguments');
 const next=values['--next-version']?Number(values['--next-version']):undefined;if(next!==undefined&&!Number.isSafeInteger(next))throw Error('invalid_arguments');
 return {action:action!,config:values['--config'],database:values['--database'],...(next===undefined?{}:{nextVersion:next})};
}
export function replaceNativeApprovalConfig(file:string,expected:LocalApprovalNativeConfig,next:LocalApprovalNativeConfig){
 if(JSON.stringify(readLocalApprovalNativeConfig(file))!==JSON.stringify(expected))throw Error('native_config_changed');
 const original=fs.lstatSync(file),temporary=file+'.'+randomUUID()+'.tmp';let fd:number|undefined;
 try{
  fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
  fs.writeFileSync(fd,JSON.stringify(next,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  const current=fs.lstatSync(file);
  if(current.dev!==original.dev||current.ino!==original.ino||JSON.stringify(readLocalApprovalNativeConfig(file))!==JSON.stringify(expected))throw Error('native_config_changed');
  fs.renameSync(temporary,file);const dir=fs.openSync(path.dirname(file),fs.constants.O_RDONLY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  if(JSON.stringify(readLocalApprovalNativeConfig(file))!==JSON.stringify(next))throw Error('native_config_unverified');
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
export async function nativeApprovalMain(args:string[]){
 const input=parseNativeApprovalArguments(args);let config=readLocalApprovalNativeConfig(input.config);
 const db=openSecurityDatabase(input.database);
 try{
  const identity=db.prepare('SELECT instance_id,owner_id FROM dashboard_operator_identity WHERE singleton=1').get() as {instance_id:string;owner_id:string}|undefined;
  if(identity?.instance_id!==config.scope.instance_id||identity.owner_id!==config.owner_id)throw Error('operator_identity_mismatch');
  if(input.action!=='doctor'&&!(input.action==='rotate'&&input.nextVersion===config.key_version)){
   if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('operator_tty_required');
   const confirmation=`${config.scope.instance_id}/${config.scope.workspace_id}/${config.owner_id}`+(input.action==='rotate'?`:rotate:${input.nextVersion}`:input.action==='recover'?':recover':'');
   const prompt=createInterface({input:process.stdin,output:process.stdout});
   let answer:string;try{answer=await prompt.question(`${input.action}を実行します。次の確認値を入力してください: ${confirmation}\n> `);}finally{prompt.close();}
   if(input.action==='provision')provisionNativeLocalApproval(db,config,answer);
   else if(input.action==='recover')recoverNativeLocalApproval(db,config,answer);
   else {const next=rotateNativeLocalApproval(db,config,input.nextVersion!,answer);replaceNativeApprovalConfig(input.config,config,next);config=next;}
  }
  const connection=new NativeLocalApprovalConnection(db,config);
  try{const result=connection.doctor();console.log(JSON.stringify(result));if(!result.ready)process.exitCode=1;}finally{connection.close();}
 }finally{db.close();}
}
// The fixed signed host imports this sealed entry; paths above are data only.
if(process.argv[1]&&path.basename(process.argv[1])==='local-native-cli.js')void nativeApprovalMain(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({ready:false,reason:'native_approval_setup_required'}));process.exitCode=1;});
