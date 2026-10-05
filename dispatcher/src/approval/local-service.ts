import {LocalApprovalOperations} from './local-operations.js';
import {stableStringify} from '../validation.js';
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
export function approvalAdmission<T extends {ready:boolean;reason?:string}>(ports:{health():T;authorize():boolean;sweep():unknown;availability(ready:boolean):Promise<unknown>;tick():Promise<unknown>}){
 let admitted=false;
 const health=()=>{try{const value=ports.health();if(!value.ready)return value;if(!ports.authorize())return {...value,ready:false,reason:'operator_state_unverified'};return admitted?value:{...value,ready:false,reason:'operations_unavailable'};}catch{return {ready:false,reason:'protected_state_unverified'};}};
 const disable=async()=>{admitted=false;await ports.availability(false).catch(()=>{});};
 const tick=async()=>{try{
  if(!ports.health().ready||!ports.authorize()){await disable();return;}
  ports.sweep();
  if(!ports.authorize())throw Error('operator_state_unverified');
  await ports.availability(true);if(!ports.authorize())throw Error('operator_state_unverified');
  await ports.tick();if(!ports.health().ready||!ports.authorize())throw Error('operator_state_unverified');admitted=true;
 }catch(error){await disable();throw error;}};
 return {health,tick,disable};
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
  const operator={
   owner_id:nativeConfig.owner_id,authorize:()=>{try{
    native!.maintenance.requireReady(nativeConfig.key_version);
    const current=sql.prepare('SELECT instance_id,owner_id FROM dashboard_operator_identity WHERE singleton=1').get() as {instance_id:string;owner_id:string}|undefined;
    return typeof process.getuid==='function'&&process.getuid()===process.geteuid?.()&&current?.instance_id===nativeConfig.scope.instance_id&&current.owner_id===nativeConfig.owner_id&&stableStringify(readLocalApprovalNativeConfig(config.localApprovalConfigPath!))===stableStringify(nativeConfig);
   }catch{return false;}},
  };
  let ingress:LocalExternalApprovalIngress;
  const service=new LocalExternalApprovalService(sql,native.providers,nativeConfig.scope,native.keys,{
   authorize:a=>operator.authorize()&&database.operatorAuth.authorize(a,'approvals:external'),
   authorizeSource:s=>operator.authorize()&&ingress?.authorizeSource(s)===true,
   verifyStepUp:r=>database.operatorWebAuthn?.verifyReceipt(r,r,'approvals:external')===true,
  },slack);
  const operations=new LocalApprovalOperations(sql,native.providers,nativeConfig.scope,native.keys,operator,{reconcile:(...args)=>slack.reconcile(...args)});
  const runtime=new RuntimeClient(runtimeSocket(config));
  ingress=database.createExternalApprovalIngress(runtime,service,{...nativeConfig.scope,owner_id:nativeConfig.owner_id,main_agent:config.agentName},wake);
  const admission=approvalAdmission({health:()=>native!.doctor(),authorize:operator.authorize,sweep:()=>operations.sweep(performance.now()+500),availability:ready=>runtime.externalAvailability(ready),tick:()=>ingress.tick()});
  const loop=approvalLoop(admission.tick,failure);
  const stop=async()=>{await loop.stop();await admission.disable();};
  return {service,async start(){loop.start();},stop,health:admission.health,async close(){await stop();native!.close();sql.close();}};
 }catch(error){native?.close();sql.close();throw error;}
}
