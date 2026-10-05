import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {approvalLoop} from '../src/approval/local-service.js';
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
