import {z} from "zod";
import type {ProtectedHeadEntry,ProtectedHeadPort} from "./protected-heads.js";
import {parseClockMark,type ClockMark} from "./clock.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema=z.strictObject({codec_version:z.literal(1),active_key_version:version,phase:z.enum(["ready","rotation","boot_recovery"]),operation_id:id.nullable(),next_key_version:version.nullable(),recovery_mark:z.unknown().nullable(),operation_config_digest:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),last_rotation:z.strictObject({from:version,to:version,operation_id:id,config_digest:z.string().regex(/^[a-f0-9]{64}$/)}).nullable().default(null)});
export interface LocalMaintenanceState {codec_version:1;active_key_version:number;phase:"ready"|"rotation"|"boot_recovery";operation_id:string|null;next_key_version:number|null;recovery_mark:ClockMark|null;operation_config_digest?:string|null;last_rotation?:{from:number;to:number;operation_id:string;config_digest:string}|null}
export function encodeLocalMaintenance(input:LocalMaintenanceState):string{
 const s=schema.parse(input);const mark=s.recovery_mark===null?null:parseClockMark(s.recovery_mark);
 if(s.phase==="ready"?(s.operation_id!==null||s.next_key_version!==null||mark!==null||s.operation_config_digest!==null):s.phase==="rotation"?(!s.operation_id||s.next_key_version!==s.active_key_version+1||!s.operation_config_digest):(!s.operation_id||s.next_key_version!==null||!mark||mark.transaction_id!==s.operation_id||!s.operation_config_digest))throw Error("local_approval_maintenance_invalid");
 return JSON.stringify({...s,recovery_mark:mark});
}
/** DB外CASに通常受付停止phaseを保存する。runtimeはreadyだけを受け入れる。 */
export class LocalMaintenanceStore {
 constructor(private readonly port:ProtectedHeadPort){}
 read():{entry:ProtectedHeadEntry;state:LocalMaintenanceState}{const entry=this.port.read(),state=JSON.parse(entry.value) as LocalMaintenanceState;if(encodeLocalMaintenance(state)!==entry.value)throw Error("local_approval_maintenance_unverified");return {entry,state};}
 requireReady(version:number){const {state}=this.read();if(state.phase!=="ready"||state.active_key_version!==version)throw Error("local_approval_maintenance_required");}
 change(expected:ReturnType<LocalMaintenanceStore["read"]>,next:LocalMaintenanceState){const value=encodeLocalMaintenance(next),accepted=this.port.compareExchange(expected.entry,value);if(accepted.revision!==expected.entry.revision+1||accepted.value!==value)throw Error("local_approval_maintenance_unknown");const current=this.read();if(current.entry.revision!==accepted.revision||current.entry.value!==value)throw Error("local_approval_maintenance_unknown");return current;}
}
