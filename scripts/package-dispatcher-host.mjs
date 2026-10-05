#!/usr/bin/env node
// unsigned stagingのみ。署名はMac operatorが別途実行する。
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {decodeProvisioningProfilePlist} from './dispatcher-host-profile.mjs';
import {bundleId,sha256,profileContract,copyTree,plist,assertHostNodeMajor} from './dispatcher-host-artifact.mjs';
const [build,release,destination,profilePath,team,group]=process.argv.slice(2);
const root=fileURLToPath(new URL('../',import.meta.url));
try{
 if(process.platform!=='darwin'||![build,release,destination,profilePath].every(x=>x&&path.isAbsolute(x))||fs.existsSync(destination))throw Error();
 const pin=JSON.parse(fs.readFileSync(path.join(root,'native/dispatcher-host/node-source.json'),'utf8'));
 const manifest=JSON.parse(fs.readFileSync(path.join(build,'host-build.json'),'utf8'));
 const binary=fs.readFileSync(path.join(build,'DonaDispatcher'));
 if(manifest.schema_version!==1||manifest.arch!==process.arch||JSON.stringify(manifest.node)!==JSON.stringify(pin)||
 manifest.host_source_sha256!==sha256(Buffer.concat(['main.cc','bootstrap.inc'].map(name=>fs.readFileSync(path.join(root,'native/dispatcher-host',name)))))||manifest.binary_sha256!==sha256(binary))throw Error();
 const cms=spawnSync('/usr/bin/security',['cms','-D','-i',profilePath],{encoding:'utf8',maxBuffer:1024*1024});if(cms.status!==0)throw Error();
 const ent=profileContract(decodeProvisioningProfilePlist(cms.stdout),team,group);
 const releaseManifest=JSON.parse(fs.readFileSync(path.join(release,'release-manifest.json'),'utf8'));if(!/^[a-f0-9]{40}$/.test(releaseManifest.sha))throw Error();
 assertHostNodeMajor(releaseManifest.node_version,pin.version);
 fs.mkdirSync(destination,{mode:0o700});const app=path.join(destination,'DonaDispatcher.app'),contents=path.join(app,'Contents');
 fs.mkdirSync(path.join(contents,'MacOS'),{recursive:true,mode:0o700});fs.mkdirSync(path.join(contents,'Resources/release'),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(contents,'MacOS/DonaDispatcher'),binary,{flag:'wx',mode:0o700});
 fs.copyFileSync(profilePath,path.join(contents,'embedded.provisionprofile'),fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(path.join(contents,'Info.plist'),plist({CFBundleIdentifier:bundleId,CFBundleExecutable:'DonaDispatcher',CFBundlePackageType:'APPL',CFBundleVersion:'1',CFBundleName:'Dona Dispatcher',LSUIElement:true}));
 // 既存native portの相対path契約を保つ。秘密設定/DB/checkout全体はコピーしない。
 for(const relative of ['dispatcher/dist','dispatcher/src/native','dispatcher/node_modules','sources/slack/dist','sources/slack/node_modules']){
   const target=path.join(contents,'Resources/release',relative);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});copyTree(path.join(release,relative),target);
 }
 for(const relative of ['dispatcher/package.json','sources/slack/package.json','release-manifest.json'])fs.copyFileSync(path.join(release,relative),path.join(contents,'Resources/release',relative));
 fs.writeFileSync(path.join(destination,'host.entitlements.plist'),plist(ent),{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(contents,'Resources/host-contract.json'),JSON.stringify({schema_version:1,team,group,bundle_id:bundleId,release_sha:releaseManifest.sha,node:pin})+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({stage:'unsigned',activation_allowed:false,release_sha:releaseManifest.sha}));
}catch{console.error('dispatcher_host_package_failed: profile・build provenance・release treeを確認してください。部分stageは再利用しません。');process.exitCode=1;}
