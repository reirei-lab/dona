import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {parseDashboardConfig,readDashboardConfig} from '../src/dashboard/config.js';
const config={schema_version:1,origin:'https://dona.example.ts.net',port:4318,control_socket:'/tmp/observer/control.sock',dispatcher_database:'/tmp/dispatcher.sqlite3',runtime_socket:'/tmp/runtime.sock'};
test('observer configはHTTP公開origin・未知設定・非保護fileを拒否する',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dona-observer-config-'))),file=path.join(root,'config.json');
 try{assert.deepEqual(parseDashboardConfig(config),config);assert.throws(()=>parseDashboardConfig({...config,origin:'http://localhost:4318'}));assert.throws(()=>parseDashboardConfig({...config,command:true}));
 fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});assert.deepEqual(readDashboardConfig(file),config);
 fs.chmodSync(file,0o644);assert.throws(()=>readDashboardConfig(file));fs.chmodSync(file,0o600);
 const link=path.join(root,'link');fs.symlinkSync(file,link);assert.throws(()=>readDashboardConfig(link));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
