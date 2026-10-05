import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNativeApprovalArguments} from '../src/approval/local-native-cli.js';
test('native承認CLIは固定modeと正規絶対pathだけを受理する',()=>{
 assert.deepEqual(parseNativeApprovalArguments(['doctor','--config','/private/config.json','--database','/private/state.sqlite']),{action:'doctor',config:'/private/config.json',database:'/private/state.sqlite'});
 for(const args of [[],['eval','--config','/a','--database','/b'],['doctor','--config','relative','--database','/b'],['doctor','--config','/a','--database','/b','--config','/c'],['doctor','--config','/a','--database','/b','--exec','/c'],['doctor','--config','/a/../b','--database','/b']])assert.throws(()=>parseNativeApprovalArguments(args),/invalid_arguments/);
});
