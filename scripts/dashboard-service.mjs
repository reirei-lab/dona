#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const label='dev.dona.dashboard';
const [operation,releaseArg,configArg,logsArg,...extra]=process.argv.slice(2);
const fail=()=>{throw Error('dashboard_service_invalid');};
function run(args){const result=spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:15000,maxBuffer:8192});if(result.error||result.status!==0)throw Error('dashboard_service_operation_failed');return result.stdout;}
function privateDirectory(file){if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)fail();const s=fs.lstatSync(file);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail();}
try{
 if(process.platform!=='darwin'||extra.length||!['render','install','start','stop','status'].includes(operation))fail();
 const domain=`gui/${process.getuid()}`,target=`${domain}/${label}`;
 if(['start','stop','status'].includes(operation)){
   if(releaseArg||configArg||logsArg)fail();
   if(operation==='start')run(['bootstrap',domain,path.join(os.homedir(),'Library/LaunchAgents',label+'.plist')]);
   if(operation==='stop')run(['bootout',target]);
   if(operation==='status')process.stdout.write(run(['print',target]));
 }else{
   if(!releaseArg||!configArg||!logsArg)fail();
   const release=fs.realpathSync(releaseArg);if(release!==releaseArg)fail();
   const manifest=JSON.parse(fs.readFileSync(path.join(release,'release-manifest.json'),'utf8'));
   if(!/^[a-f0-9]{40}$/.test(manifest.sha)||!/^[a-f0-9]{64}$/.test(manifest.lock_hashes?.['sources/web']))fail();
   const {readDashboardConfig}=await import(pathToFileURL(path.join(release,'dispatcher/dist/dashboard/config.js')).href);
   const config=readDashboardConfig(configArg);privateDirectory(path.dirname(config.control_socket));privateDirectory(logsArg);
   let executableRelease=release;
   if(config.active_release_pointer){
     const {readDashboardRelease}=await import(pathToFileURL(path.join(release,'dispatcher/dist/dashboard/release-pointer.js')).href);
     const current=readDashboardRelease(config.active_release_pointer);if(current.root!==release||current.sha!==manifest.sha)fail();
     executableRelease=config.active_release_pointer;
   }
   const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
   let template=fs.readFileSync(new URL('../launchd/dev.dona.dashboard.plist.in',import.meta.url),'utf8');
   for(const [name,value]of Object.entries({NODE:fs.realpathSync(process.execPath),RELEASE:executableRelease,CONFIG:configArg,LOG_ROOT:logsArg}))template=template.replaceAll(`__${name}__`,xml(value));
   if(/__[A-Z_]+__/.test(template))fail();
   if(operation==='render')process.stdout.write(template);
   else{
     // An update must explicitly stop this service first. Never bootout another service.
     const existing=spawnSync('/bin/launchctl',['print',target],{encoding:'utf8',timeout:5000,maxBuffer:8192});
     if(existing.error||existing.status!==113)throw Error('dashboard_service_stop_required');
     const directory=path.join(os.homedir(),'Library/LaunchAgents');fs.mkdirSync(directory,{recursive:true,mode:0o700});
     const info=fs.lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o022))fail();
     const file=path.join(directory,label+'.plist');
     if(fs.existsSync(file)){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1)fail();}
     const temporary=file+'.tmp';const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,template);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
     process.stdout.write('Web serviceを登録用に配置しました。startで起動してください。\n');
   }
 }
}catch{process.stderr.write('dashboard_service_operation_failed\n');process.exitCode=1;}
