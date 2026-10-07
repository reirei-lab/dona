import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../src/app-server/store.js';
import {projectNotification,projectHistory} from '../src/app-server/observation.js';
import {DashboardObserver} from '../src/dashboard/observer.js';
import type {DashboardTaskReader} from '../src/dashboard/task-reader.js';

test('App Server由来の日時が保存・再読・公開境界を通り観測時刻と混ざらない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dona-times-')),file=join(root,'runtime.sqlite');let store=new RuntimeStore(file);
 try {
  const at='2026-10-06T01:02:03.456Z',ms=Date.parse(at);
  store.observe('main','g',projectNotification('item/started',{turnId:'turn',item:{id:'item'},startedAtMs:ms})!);
  const item=projectHistory({thread:{id:'thread',turns:[{id:'turn',startedAt:Math.floor(ms/1000),items:[{id:'item',type:'agentMessage',text:'確認しました'}]}]}}).items[0]!;
  store.cacheItem('main','g',item);store.close();store=new RuntimeStore(file);
  const identity={name:'main',generation:'g',role:'main' as const,thread_id:'thread',attempt_id:null,connected:false,observed_at:new Date().toISOString(),state:'idle'};
  const observer=new DashboardObserver({} as DashboardTaskReader,{async conversations(){return {items:[identity],next:null};},async conversation(){return {...identity,...store.observations('main','g'),items:store.cachedItems('main','g'),truncated:false};}});
  const result=await observer.mainDetail('main','g',()=>({revision:'1',task:()=>false,conversation:()=>false,mainConversation:()=>true}));
  assert.equal(result?.status,'observed');if(result?.status!=='observed')throw Error('日時の公開に失敗');
  assert.equal(result.conversation.events[0]?.occurred_at,at);assert.notEqual(result.conversation.events[0]?.observed_at,at);
  assert.equal(result.conversation.items[0]?.turn_started_at,'2026-10-06T01:02:03.000Z');
 }finally {store.close();await rm(root,{recursive:true,force:true});}
});

 test('大きなApp Server差分も公開境界で欠落・改変しない',async()=>{
 const diff='password=example-only\n'+'x'.repeat(1100000);
 const item=projectHistory({thread:{id:'thread',turns:[{id:'turn',items:[{id:'diff',type:'fileChange',changes:[{path:'.env',kind:{type:'add'},diff}]}]}]}}).items[0]!;
 const identity={name:'main',generation:'g',role:'main' as const,thread_id:'thread',attempt_id:null,connected:false,observed_at:new Date().toISOString(),state:'idle'};
 const observer=new DashboardObserver({} as DashboardTaskReader,{async conversations(){return {items:[identity],next:null};},async conversation(){return {...identity,items:[item],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};}});
 const result=await observer.mainDetail('main','g',()=>({revision:'1',task:()=>false,conversation:()=>false,mainConversation:()=>true}));
 assert.equal(result?.status,'observed');if(result?.status!=='observed')throw Error('差分の公開に失敗');assert.equal(result.conversation.items[0]?.files?.[0]?.diff,diff);
 });
