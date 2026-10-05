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

/** Fixed sibling modules from the same signed release; no configurable module,
 * credential command, or browser-provided path is loaded. */
async function credential(alias:string):Promise<()=>Promise<string>> {
 const base=new URL('../../../',import.meta.url);
 const [{loadStoredSlackBotToken},{MacOSKeychainStore},{loadRuntimeConfig}]=await Promise.all([
  import(new URL('sources/slack/dist/credentials.js',base).href),
  import(new URL('sources/slack/dist/keychain.js',base).href),
  import(new URL('sources/slack/dist/config.js',base).href),
 ]);
 if(!loadRuntimeConfig().workspaces.includes(alias))throw Error('local_approval_workspace_unavailable');
 const keychain=new MacOSKeychainStore();
 return ()=>loadStoredSlackBotToken(alias,keychain);
}
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
  const token=await credential(nativeConfig.slack_workspace_alias);
  const revisionKey=createHmac('sha256',native.keys.content(null).secret).update('dona.local-approval.thread-revision.v1').digest();
  const slack=new LocalSlackApprovalProvider(nativeConfig.scope.workspace_id,token,revisionKey);
  let ingress:LocalExternalApprovalIngress;
  const service=new LocalExternalApprovalService(sql,native.providers,nativeConfig.scope,native.keys,{
   authorize:a=>database.operatorAuth.authorize(a,'approvals:external'),
   authorizeSource:s=>ingress?.authorizeSource(s)===true,
   verifyStepUp:r=>database.operatorWebAuthn?.verifyReceipt(r,r,'approvals:external')===true,
  },slack);
  ingress=database.createExternalApprovalIngress(new RuntimeClient(runtimeSocket(config)),service,{...nativeConfig.scope,owner_id:nativeConfig.owner_id,main_agent:config.agentName},wake);
  const loop=approvalLoop(()=>ingress.tick(),failure);
  return {service,start:()=>loop.start(),stop:()=>loop.stop(),health:()=>native!.doctor(),async close(){await loop.stop();native!.close();sql.close();}};
 }catch(error){native?.close();sql.close();throw error;}
}
