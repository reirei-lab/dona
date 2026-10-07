import {randomUUID} from "node:crypto";
import {assertSynchronousCallback,assertSynchronousResult} from "../audit/synchronous.js";
import type {LocalMaintenanceStore,LocalMaintenanceState} from "./local-maintenance.js";
/** operator entryだけが使うrotation protocol。callbacksはnative key/auditの固定provider。 */
export function rotateProtectedKeys(store:LocalMaintenanceStore,currentVersion:number,nextVersion:number,configDigest:string,ports:{
 change(expected:ReturnType<LocalMaintenanceStore["read"]>,next:LocalMaintenanceState):ReturnType<LocalMaintenanceStore["read"]>;
 stageNewKeys():void;auditAndInvalidate(operationId:string):void;retireOldKeys():void;
}):number{
 if(!Number.isSafeInteger(nextVersion)||nextVersion!==currentVersion+1||!/^[a-f0-9]{64}$/.test(configDigest))throw Error("local_approval_rotation_version_invalid");
 for(const callback of [ports.change,ports.stageNewKeys,ports.auditAndInvalidate,ports.retireOldKeys])assertSynchronousCallback(callback);
 let current=store.read();
 if(current.state.phase==="ready"&&current.state.active_key_version===nextVersion&&current.state.last_rotation?.from===currentVersion&&current.state.last_rotation.to===nextVersion&&current.state.last_rotation.config_digest===configDigest)return nextVersion;
 if(current.state.active_key_version!==currentVersion)throw Error("local_approval_rotation_version_invalid");
 if(current.state.phase==="boot_recovery"&&current.state.operation_config_digest!==configDigest)throw Error("local_approval_maintenance_conflict");
 if(current.state.phase==="ready"||current.state.phase==="boot_recovery")current=ports.change(current,{...current.state,phase:"rotation",operation_id:"rotate_"+randomUUID().replaceAll("-",""),next_key_version:nextVersion,operation_config_digest:configDigest});
 if(current.state.phase!=="rotation"||current.state.next_key_version!==nextVersion||current.state.operation_config_digest!==configDigest)throw Error("local_approval_maintenance_conflict");
 assertSynchronousResult(ports.stageNewKeys());assertSynchronousResult(ports.auditAndInvalidate(current.state.operation_id!));assertSynchronousResult(ports.retireOldKeys());
 const last=store.read();if(last.state.phase!=="rotation"||last.state.operation_id!==current.state.operation_id||last.state.next_key_version!==nextVersion)throw Error("local_approval_maintenance_conflict");
 ports.change(last,{codec_version:1,phase:"ready",active_key_version:nextVersion,operation_id:null,next_key_version:null,recovery_mark:null,last_rotation:{from:currentVersion,to:nextVersion,operation_id:current.state.operation_id!,config_digest:configDigest}});return nextVersion;
}
