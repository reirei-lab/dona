import {localApprovalCredential} from './local-credential.js';
import {createHmac} from 'node:crypto';
import type {DispatcherDatabase} from '../database.js';
import type {DispatcherConfig} from '../config.js';
import {RuntimeClient} from '../app-server/client.js';
import {runtimeSocket} from '../app-server/adapters.js';
import {openSecurityDatabase} from '../audit/coordination.js';
import {NativeLocalApprovalConnection,readLocalApprovalNativeConfig} from './local-native.js';
import {LocalExternalApprovalService} from './local-external-service.js';
import {LocalSlackApprovalProvider} from './local-slack-provider.js';
import type {LocalExternalApprovalIngress} from './local-ingress.js';

export interface LocalApprovalLoop {start():void;stop():Promise<void>}
/** One outstanding tick; shutdown waits for an in-flight effect before DB close. */
export function approvalLoop(tick:()=>Promise<unknown>,failure:()=>void,interval=1000):LocalApprovalLoop {
 let timer:ReturnType<typeof setTimeout>|undefined,running=false,pending:Promise<void>|undefined;
 const run=()=>{
  if(!running||pending)return;
  pending=Promise.resolve().then(tick).then(()=>{},failure).finally(()=>{pending=undefined;if(running){timer=setTimeout(run,interval);timer.unref();}});
 };
 return {start(){if(running)return;running=true;run();},async stop(){running=false;clearTimeout(timer);await pending;}};
}
export async function openLocalApprovalService(database:DispatcherDatabase,config:DispatcherConfig,wake:()=>void,failure:()=>void){
 if(!config.localApprovalConfigPath)return undefined;
 const nativeConfig=readLocalApprovalNativeConfig(config.localApprovalConfigPath);
 if(nativeConfig.scope.instance_id!==database.operatorAuth.instance_id||nativeConfig.owner_id!==database.operatorAuth.owner_id)throw Error('local_approval_owner_mismatch');
 const sql=openSecurityDatabase(config.databasePath);let native:NativeLocalApprovalConnection|undefined;
 try{
  native=new NativeLocalApprovalConnection(sql,nativeConfig);
  if(!native.doctor().ready)throw Error('local_approval_setup_required');
  const token=await localApprovalCredential(nativeConfig.slack_workspace_alias);
  const revisionKey=createHmac('sha256',native.keys.content(null).secret).update('dona.local-approval.thread-revision.v1').digest();
  const slack=new LocalSlackApprovalProvider(nativeConfig.scope.workspace_id,token,revisionKey);
  let ingress:LocalExternalApprovalIngress;
  const service=new LocalExternalApprovalService(sql,native.providers,nativeConfig.scope,native.keys,{
   authorize:a=>database.operatorAuth.authorize(a,'approvals:external'),
   authorizeSource:s=>ingress?.authorizeSource(s)===true,
   verifyStepUp:r=>database.operatorWebAuthn?.verifyReceipt(r,r,'approvals:external')===true,
  },slack);
  const runtime=new RuntimeClient(runtimeSocket(config));
  ingress=database.createExternalApprovalIngress(runtime,service,{...nativeConfig.scope,owner_id:nativeConfig.owner_id,main_agent:config.agentName},wake);
  const loop=approvalLoop(async()=>{
   const ready=native!.doctor().ready;await runtime.externalAvailability(ready);
   if(ready)await ingress.tick();
  },failure);
  const stop=async()=>{await loop.stop();await runtime.externalAvailability(false).catch(()=>{});};
  return {service,async start(){await runtime.externalAvailability(native!.doctor().ready);loop.start();},stop,health:()=>native!.doctor(),async close(){await stop();native!.close();sql.close();}};
 }catch(error){native?.close();sql.close();throw error;}
}
