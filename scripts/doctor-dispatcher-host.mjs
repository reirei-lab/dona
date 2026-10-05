#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {decodeProvisioningProfilePlist} from './dispatcher-host-profile.mjs';
import {bundleId,profileContract,assertNativeDoctor} from './dispatcher-host-artifact.mjs';
const [app,expectedTeam,expectedGroup]=process.argv.slice(2);
const result={artifact:'unverified',profile:'unverified',host:'not_started',native:'unverified',protected_state:'not_checked',slack:'not_checked',activation_allowed:false};
const run=(command,args,input)=>{const r=spawnSync(command,args,{input,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});if(r.status!==0||r.error)throw Error();return r.stdout;};
try {
 if(process.platform!=='darwin'||!app||!path.isAbsolute(app)||fs.realpathSync(app)!==app||!/^[A-Z0-9]{10}$/.test(expectedTeam||'')||!/^[A-Z0-9]{10}\.dev\.dona\.approval$/.test(expectedGroup||''))throw Error();
 const c=path.join(app,'Contents'),contract=JSON.parse(fs.readFileSync(path.join(c,'Resources/host-contract.json'),'utf8'));
 if(contract.team!==expectedTeam||contract.group!==expectedGroup||contract.bundle_id!==bundleId)throw Error();
 run('/usr/bin/codesign',['--verify','--strict','--deep','--all-architectures','-R',`anchor apple generic and certificate leaf[subject.OU] = "${expectedTeam}" and identifier "${bundleId}"`,app]);result.artifact='verified';
 const profile=decodeProvisioningProfilePlist(run('/usr/bin/security',['cms','-D','-i',path.join(c,'embedded.provisionprofile')]));
 const expected=profileContract(profile,expectedTeam,expectedGroup);
 const actual=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-','-'],run('/usr/bin/codesign',['-d','--entitlements',':-',app])));
 for(const [key,value] of Object.entries(expected))if(JSON.stringify(actual[key])!==JSON.stringify(value))throw Error();
 for(const key of ['com.apple.security.get-task-allow','com.apple.security.cs.disable-library-validation','com.apple.security.cs.allow-dyld-environment-variables','com.apple.security.cs.allow-unsigned-executable-memory'])if(key in actual)throw Error();
 result.profile='verified';
 const host=JSON.parse(run(path.join(c,'MacOS/DonaDispatcher'),['host-doctor']));if(host.signature!=='verified')throw Error();result.host='verified';
 assertNativeDoctor(JSON.parse(run(path.join(c,'MacOS/DonaDispatcher'),['host-native-doctor'])));result.native='verified';
 // 配備artifactの検査のみ。approval/Slack/DB/runtimeの準備完了とは別。
 result.activation_allowed=true;
}catch{process.exitCode=1;}
console.log(JSON.stringify(result));
