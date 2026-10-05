#!/usr/bin/env node
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {openSecurityDatabase} from '../audit/coordination.js';
import {NativeLocalApprovalConnection,readLocalApprovalNativeConfig,provisionNativeLocalApproval} from './local-native.js';

export function parseNativeApprovalArguments(args:string[]){
 const action=args[0];if(!['doctor','provision'].includes(action??''))throw Error('invalid_arguments');
 const values:Record<string,string>={};
 for(let i=1;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!name||!['--config','--database'].includes(name)||!value||values[name]||!path.isAbsolute(value)||path.normalize(value)!==value)throw Error('invalid_arguments');values[name]=value;}
 if(!values['--config']||!values['--database'])throw Error('invalid_arguments');
 return {action:action!,config:values['--config'],database:values['--database']};
}
export async function nativeApprovalMain(args:string[]){
 const input=parseNativeApprovalArguments(args),config=readLocalApprovalNativeConfig(input.config);
 const db=openSecurityDatabase(input.database);
 try{
  const identity=db.prepare('SELECT instance_id,owner_id FROM dashboard_operator_identity WHERE singleton=1').get() as {instance_id:string;owner_id:string}|undefined;
  if(identity?.instance_id!==config.scope.instance_id||identity.owner_id!==config.owner_id)throw Error('operator_identity_mismatch');
  if(input.action==='provision'){
   if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('operator_tty_required');
   const confirmation=`${config.scope.instance_id}/${config.scope.workspace_id}/${config.owner_id}`;
   const prompt=createInterface({input:process.stdin,output:process.stdout});
   let answer:string;try{answer=await prompt.question(`初回provisionを実行します。次の確認値を入力してください: ${confirmation}\n> `);}finally{prompt.close();}
   provisionNativeLocalApproval(db,config,answer);
  }
  const connection=new NativeLocalApprovalConnection(db,config);
  try{const result=connection.doctor();console.log(JSON.stringify(result));if(!result.ready)process.exitCode=1;}finally{connection.close();}
 }finally{db.close();}
}
// The fixed signed host imports this sealed entry; paths above are data only.
if(process.argv[1]&&path.basename(process.argv[1])==='local-native-cli.js')void nativeApprovalMain(process.argv.slice(2)).catch(()=>{console.error(JSON.stringify({ready:false,reason:'native_approval_setup_required'}));process.exitCode=1;});
