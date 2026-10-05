import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operatorRuntimeFixture} from './operator-runtime-fixture.js';
test('Unix fixtureはbind直後からowner-onlyで、chmod待ちの窓でも実Runtimeの検査を通る',async()=>{
 const previous=process.umask(0o022);
 try{
  const fixture=await operatorRuntimeFixture('https://fixture.test',{status:200,headers:{},body:'fixture'},{socketPermissionDelayMs:500});
  try{
   const agents=await fixture.client.list();assert.equal(agents.length,1);assert.equal(agents[0]!.state,'idle');
   const calls=await fixture.calls(),published=calls.find(call=>call.method==='fixture/socketPublished');assert.ok(published);assert.equal(published.mode!&0o077,0);assert.equal(calls.filter(call=>call.method==='initialize').length,1);assert.equal(calls.filter(call=>call.method==='thread/start').length,1);
  }finally{await fixture.close();}
 }finally{process.umask(previous);}
});
