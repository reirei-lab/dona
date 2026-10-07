import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {approvalLoop,approvalAdmission} from '../src/approval/local-service.js';
test('外部承認の常駐処理は重複tickせず停止時に進行中処理を待つ',async()=>{
 let release!:()=>void,calls=0,failures=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const loop=approvalLoop(async()=>{calls++;await gate;},()=>{failures++;},1);
 loop.start();loop.start();await delay(10);assert.equal(calls,1);
 let stopped=false;const stopping=loop.stop().then(()=>{stopped=true;});await delay(10);assert.equal(stopped,false);
 release();await stopping;await delay(10);assert.equal(calls,1);assert.equal(failures,0);
});
test('tick失敗を報告して次回照合へ進み停止後は再実行しない',async()=>{
 let failures=0,calls=0;const loop=approvalLoop(async()=>{calls++;throw Error('fixture');},()=>{failures++;},1);
 loop.start();await delay(20);await loop.stop();assert.ok(calls>1);assert.equal(failures,calls);const count=calls;await delay(10);assert.equal(calls,count);
});

test('保守失敗とowner/config失効は受付を閉じ、healthをreadyにしない',async()=>{
 let allowed=true,failSweep=false,sweeps=0,ticks=0;const availability:boolean[]=[];
 const admission=approvalAdmission({health:()=>({ready:true}),authorize:()=>allowed,sweep:()=>{sweeps++;if(failSweep)throw Error('sweep_unverified');},availability:async ready=>{availability.push(ready);},tick:async()=>{ticks++;}});
 assert.equal(admission.health().ready,false);await admission.tick();assert.equal(admission.health().ready,true);
 allowed=false;assert.equal(admission.health().ready,false);await admission.tick();assert.equal(sweeps,1);assert.equal(ticks,1);assert.equal(availability.at(-1),false);
 allowed=true;failSweep=true;await assert.rejects(admission.tick(),/sweep_unverified/);assert.equal(admission.health().ready,false);assert.equal(availability.at(-1),false);assert.equal(ticks,1);
 failSweep=false;await admission.tick();assert.equal(admission.health().ready,true);await admission.disable();assert.equal(admission.health().ready,false);assert.equal(availability.at(-1),false);
});
test('Runtime応答中の認可失効と切断でも新規受付を維持しない',async()=>{
 let allowed=true,fail=false,ticks=0;const values:boolean[]=[];
 const admission=approvalAdmission({health:()=>({ready:true}),authorize:()=>allowed,sweep:()=>{},availability:async ready=>{values.push(ready);if(ready){if(fail)throw Error('runtime_lost');allowed=false;}},tick:async()=>{ticks++;}});
 await assert.rejects(admission.tick(),/operator_state_unverified/);assert.deepEqual(values,[true,false]);assert.equal(ticks,0);assert.equal(admission.health().ready,false);
 allowed=true;fail=true;await assert.rejects(admission.tick(),/runtime_lost/);assert.deepEqual(values,[true,false,true,false]);assert.equal(admission.health().ready,false);
});
