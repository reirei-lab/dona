import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';

test('private設定aliasを固定release loaderへ渡しDispatcher環境のworkspace一覧に依存しない',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dona-credential-release-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const repository=new URL('../../',import.meta.url);
 const copy=async(source:URL,target:string)=>{await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,stripTypeScriptTypes(await fs.readFile(source,'utf8'),{mode:'transform'}));};
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'}));
 const loader=path.join(root,'dispatcher/dist/approval/local-credential.js');await copy(new URL('dispatcher/src/approval/local-credential.ts',repository),loader);
 for(const name of ['config','credentials','keychain'])await copy(new URL(`sources/slack/src/${name}.ts`,repository),path.join(root,`sources/slack/dist/${name}.js`));
 const stub=path.join(root,'node_modules/@github/keytar');await fs.mkdir(stub,{recursive:true});await fs.writeFile(path.join(stub,'package.json'),JSON.stringify({type:'module',main:'index.js'}));
 await fs.writeFile(path.join(stub,'index.js'),`export default {getPassword:async(service,account)=>{if(service!=='dona.slack-source'||account!=='approved.slack-bot-token')throw Error('wrong_credential_scope');return 'xoxb-fixture-only';},setPassword:async()=>{throw Error('unexpected_write');}};`);
 const {localApprovalCredential}=await import(pathToFileURL(loader).href);
 const previous=process.env.SLACK_WORKSPACES;try{
  delete process.env.SLACK_WORKSPACES;assert.equal(await(await localApprovalCredential('approved'))(),'xoxb-fixture-only');
  process.env.SLACK_WORKSPACES='other';assert.equal(await(await localApprovalCredential('approved'))(),'xoxb-fixture-only');
  await assert.rejects(localApprovalCredential('approved,other'));await assert.rejects(localApprovalCredential('../invalid'));
 }finally{if(previous===undefined)delete process.env.SLACK_WORKSPACES;else process.env.SLACK_WORKSPACES=previous;}
});
