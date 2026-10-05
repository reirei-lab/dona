#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const [release,configuration]=process.argv.slice(2);
try{
 if(!release||!configuration||!path.isAbsolute(release)||!path.isAbsolute(configuration))throw Error();
 const info=fs.lstatSync(configuration);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw Error();
 const c=JSON.parse(fs.readFileSync(configuration,'utf8'));
 const root=fs.realpathSync(release),app=path.join(root,'signed-host/DonaDispatcher.app');
 const contract=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/host-contract.json'),'utf8'));
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8'));if(contract.release_sha!==manifest.sha)throw Error();
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./doctor-dispatcher-host.mjs',import.meta.url)),app,c.team_id,c.access_group],{stdio:'inherit'});if(r.status!==0||r.error)throw Error();
}catch{console.error('signed_dispatcher_release_unverified: 初回切替は専用cutoverが必要です。既存serviceは停止しません。');process.exitCode=1;}
