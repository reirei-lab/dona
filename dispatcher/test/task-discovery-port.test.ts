import assert from 'node:assert/strict';
import {test} from 'node:test';
import {denyTaskDiscoveryPort,type DiscoveryScope,type DiscoveryCandidate,type TaskDiscoveryPort} from '../src/task-discovery-port.js';

const scope:DiscoveryScope={tenant_id:'tenant',workspace_id:'workspace',principal_id:'owner',
 destination:{workspace_id:'workspace',channel_id:'channel',thread_ts:'123.456'},principal_revision:1,policy_revision:1};
const row=(id:string):DiscoveryCandidate=>({task_id:`task_${id}`,job_id:`job_${id}`,repository_node_id:'repo',issue_node_id:id,binding_revision:1,resource_revision:1});
/** fixtureのみ。#143のpagination実装を複製してproductionへ配線しない。
 * cursorは可視集合のoffsetだけ。policy/binding世代はserver側に保存し公開しない。 */
function fixture() {
 let revision=1,principal='owner',now=0,expires=10;
 const visible=new Set(['a','b','c']);
 const cursors=new Map<string,{offset:number;revision:number;principal:string}>();
 const port:TaskDiscoveryPort={project(s,c){
  if(s.principal_id!==principal||s.principal_revision!==1||s.policy_revision!==1||
   s.tenant_id!=='tenant'||s.workspace_id!=='workspace'||s.destination.workspace_id!=='workspace'||
   s.destination.channel_id!=='channel'||s.destination.thread_ts!=='123.456'||
   now>=expires||c.repository_node_id!=='repo'||c.binding_revision!==1||c.resource_revision!==1||!visible.has(c.issue_node_id))return null;
  return {task_id:c.task_id,job_id:c.job_id};
 }};
 const denied={status:'not_available'};
 function page(rows:DiscoveryCandidate[],s=scope,cursor?:string,p:TaskDiscoveryPort=port) {
  const currentPrincipal=principal,epoch=revision;
  const saved=cursor?cursors.get(cursor):undefined;
  if(cursor&&(!saved||saved.revision!==epoch||saved.principal!==currentPrincipal))return denied;
  const items=rows.flatMap(c=>{const v=p.project(s,c);return v?[v]:[];});
  // query中も現在identityを再確認する。旧listへのfallbackはない。
  if(principal!==currentPrincipal||revision!==epoch||now>=expires||s.principal_id!==principal)return denied;
  const offset=saved?.offset??0,next=offset+1<items.length?`page-${offset+1}`:null;
  if(next)cursors.set(next,{offset:offset+1,revision:epoch,principal:currentPrincipal});
  return {status:'available',items:items.slice(offset,offset+1),count:items.length,truncated:next!==null,cursor:next};
 }
 return {page,port,visible,revoke(){visible.clear();revision++;},drift(){revision++;},principal(){principal='other';},expire(){now=expires;}};
}
test('default denyは候補0/1/複数でprojectionを返さずwrite権限も持たない',()=>{
 for(const rows of [[],[row('a')],[row('a'),row('b')]]){
  const f=fixture();assert.deepEqual(f.page(rows,scope,undefined,denyTaskDiscoveryPort),{status:'available',items:[],count:0,truncated:false,cursor:null});
 }
 assert.deepEqual(Object.keys(denyTaskDiscoveryPort),['project']);
});
test('不可視候補を前後pageへ混ぜても存在・count・cursor・truncatedが変わらない',()=>{
 const clean=fixture(),mixed=fixture();const rows=[row('a'),row('b'),row('c')];
 const hidden=[row('secret-before'),rows[0]!,row('secret-middle'),rows[1]!,rows[2]!,row('secret-after')];
 for(const cursor of [undefined,'page-1','page-2'])assert.deepEqual(mixed.page(hidden,scope,cursor),clean.page(rows,scope,cursor));
 assert.equal(JSON.stringify(mixed.page(hidden)).includes('secret'),false);
 assert.deepEqual(fixture().page([row('hidden')]),fixture().page([]));
});
test('可視0/1/複数の判定を全可視集合に限定し一意候補からwrite capabilityを作らない',()=>{
 for(const n of [0,1,3]){const f=fixture();const result=f.page(['a','b','c'].slice(0,n).map(row));
  assert.equal('count' in result&&result.count,n);assert.equal('truncated' in result&&result.truncated,n>1);
  assert.equal('authority' in result,false);assert.equal('write' in result,false);
 }
});
test('page間revoke/expiry/revision/principal変更・restartで同じpublic deny',()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>f.revoke(),(f:ReturnType<typeof fixture>)=>f.expire(),
  (f:ReturnType<typeof fixture>)=>f.drift(),(f:ReturnType<typeof fixture>)=>f.principal()]){
  const f=fixture();f.page([row('a'),row('b')]);mutate(f);
  assert.deepEqual(f.page([row('a'),row('b')],scope,'page-1'),{status:'not_available'});
 }
 assert.deepEqual(fixture().page([row('a')],scope,'page-1'),{status:'not_available'});
});
test('exact bindingと宛先の差替えをdenyしquery中principal変更も再確認',()=>{
 const f=fixture();for(const patch of [{binding_revision:2},{resource_revision:2},{repository_node_id:'other'},{issue_node_id:'other'}])
  assert.deepEqual(f.page([{...row('a'),...patch}]),fixture().page([]));
 assert.deepEqual(f.page([row('a')],{...scope,destination:{...scope.destination,channel_id:'public'}}),fixture().page([]));
 const port:TaskDiscoveryPort={project(s,c){const projected=f.port.project(s,c);f.principal();return projected;}};
 assert.deepEqual(f.page([row('a')],scope,undefined,port),{status:'not_available'});
});
