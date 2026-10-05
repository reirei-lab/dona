import {spawnSync} from 'node:child_process';

/** CMS-decoded plist contains Date/Data values that plutil cannot encode as JSON.
 * Project only the contract fields, without certificate bytes or unrelated IDs. */
export function decodeProvisioningProfilePlist(bytes) {
 const source=`import sys,plistlib,json,datetime
p=plistlib.loads(sys.stdin.buffer.read())
keys=('TeamIdentifier','Platform','ExpirationDate','ApplicationIdentifierPrefix','ProvisionsAllDevices')
e=p.get('Entitlements',{})
allowed=('com.apple.developer.team-identifier','com.apple.application-identifier','keychain-access-groups','com.apple.security.get-task-allow')
r={k:p[k] for k in keys if k in p}
r['Entitlements']={k:e[k] for k in allowed if k in e}
if isinstance(r.get('ExpirationDate'),datetime.datetime):
 r['ExpirationDate']=r['ExpirationDate'].replace(tzinfo=datetime.timezone.utc).isoformat()
print(json.dumps(r))
`;
 const result=spawnSync('/usr/bin/python3',['-c',source],{input:bytes,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin'}});
 if(result.status!==0||result.error)throw Error('dispatcher_host_profile_invalid');
 try{return JSON.parse(result.stdout);}catch{throw Error('dispatcher_host_profile_invalid');}
}
