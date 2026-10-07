import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const bundleId='dev.dona.dispatcher.host';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function profileContract(profile,team,group,now=Date.now()) {
  const e=profile?.Entitlements;
  if(!/^[A-Z0-9]{10}$/.test(team)||!new RegExp('^[A-Z0-9]{10}\\.dev\\.dona\\.approval$').test(group)||
    !Array.isArray(profile?.TeamIdentifier)||!profile.TeamIdentifier.includes(team)||
    !Array.isArray(profile?.Platform)||!profile.Platform.some(x=>x==='OSX'||x==='macOS')||
    !Number.isFinite(Date.parse(profile.ExpirationDate))||Date.parse(profile.ExpirationDate)<=now||
    e?.['com.apple.developer.team-identifier']!==team||
    typeof e?.['com.apple.application-identifier']!=='string'||
    !Array.isArray(profile.ApplicationIdentifierPrefix)||
    !profile.ApplicationIdentifierPrefix.some(prefix=>e['com.apple.application-identifier']===`${prefix}.${bundleId}`&&group.startsWith(prefix+'.'))||
    !Array.isArray(e['keychain-access-groups'])||!e['keychain-access-groups'].some(x=>x===group||x===group.split('.')[0]+'.*')||
    e['com.apple.security.get-task-allow']===true||profile.ProvisionsAllDevices!==true)throw Error('dispatcher_host_profile_invalid');
  return {'com.apple.application-identifier':e['com.apple.application-identifier'],'com.apple.developer.team-identifier':team,
    'keychain-access-groups':[group],'com.apple.security.cs.allow-jit':true};
}
export function copyTree(source,target) {
  const s=fs.lstatSync(source);
  if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1))throw Error('dispatcher_host_resource_invalid');
  if(s.isDirectory()){
    fs.mkdirSync(target,{mode:0o700});
    for(const name of fs.readdirSync(source).sort()) {if(name==='.bin')continue;copyTree(path.join(source,name),path.join(target,name));}
  }else{fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,s.mode&0o111?0o700:0o600);}
}
export function plist(value) {
  const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const v=x=>Array.isArray(x)?'<array>'+x.map(v).join('')+'</array>':typeof x==='boolean'?`<${x?'true':'false'}/>`:typeof x==='object'?'<dict>'+Object.entries(x).map(([k,w])=>'<key>'+esc(k)+'</key>'+v(w)).join('')+'</dict>':'<string>'+esc(x)+'</string>';
  return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">'+v(value)+'</plist>\n';
}

/** native ABI smokeの前にも、異なるmajorで作ったreleaseをstageしない。 */
export function assertHostNodeMajor(releaseVersion, hostVersion) {
  const major = value => typeof value === 'string' && /^(0|[1-9][0-9]*)\.[0-9]+\.[0-9]+$/.test(value) ? Number(value.split('.')[0]) : null;
  const release = major(releaseVersion), host = major(hostVersion);
  if (release === null || host === null || release !== host) throw Error('dispatcher_host_node_major_mismatch');
}
export function assertNativeDoctor(value) {
  if (value?.native !== 'verified' || value.sqlite !== 'loaded' || value.keytar !== 'loaded') throw Error('dispatcher_host_native_unverified');
}
