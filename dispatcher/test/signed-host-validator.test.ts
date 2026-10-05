import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {jobResultValidationCommand,jobResultValidationReadPaths} from '../src/job-result-validation-command.js';
test('固定hostはworker検証に任意script/Nodeoptionを渡さない',()=>{
 Object.defineProperty(process,'donaHost',{value:'signed-v1',configurable:true});
 try{assert.deepEqual(jobResultValidationCommand(true),[process.execPath,'validate-job-result']);assert.deepEqual(jobResultValidationCommand(false),[process.execPath,'validate-job-result']);assert.ok(jobResultValidationReadPaths().includes(path.resolve(path.dirname(process.execPath),'../..')));}finally{delete (process as typeof process&{donaHost?:string}).donaHost;}
});
