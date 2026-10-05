import type {Compatibility,SchemaRollout} from './types.js';
export const taskGenerationPolicy={mode:'forward_only',schema:4,task_execution_version:1} as const;
export const taskGenerationRollout={schema_version:1,phase:'fresh_generation',database_schema:4,task_execution_version:1,online_migration:false,rollback_to_legacy:false,requires_old_worker_stop:true,requires_no_recreation_fence:true,preserve_old_database_and_artifacts:true} as const;
function equal(a:unknown,b:unknown):boolean {if(!a||typeof a!=='object'||Array.isArray(a))return false;const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;return Object.keys(aa).length===Object.keys(bb).length&&Object.entries(bb).every(([k,v])=>aa[k]===v);}
export function validTaskGenerationPolicy(value:unknown):boolean{return equal(value,taskGenerationPolicy);}
export function isTaskGenerationRollout(value:unknown):value is SchemaRollout{return equal(value,taskGenerationRollout);}
export function sameTaskGeneration(from:Compatibility,to:Compatibility):boolean {
 return from.protocol===to.protocol&&from.config===to.config&&[from,to].every(c=>c.app_schema_read_min===4&&c.app_schema_read_max===4&&c.app_schema_write===4&&c.rollback_safe===false);
}
