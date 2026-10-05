/** Fixed sibling modules from the same signed release; no configurable module,
 * credential command, or browser-provided path is loaded. */
export async function localApprovalCredential(alias:string):Promise<()=>Promise<string>> {
 const base=new URL('../../../',import.meta.url);
 const [{loadStoredSlackBotToken},{MacOSKeychainStore},{loadRuntimeConfig}]=await Promise.all([
  import(new URL('sources/slack/dist/credentials.js',base).href),
  import(new URL('sources/slack/dist/keychain.js',base).href),
  import(new URL('sources/slack/dist/config.js',base).href),
 ]);
 if(!loadRuntimeConfig().workspaces.includes(alias))throw Error('local_approval_workspace_unavailable');
 const keychain=new MacOSKeychainStore();
 return ()=>loadStoredSlackBotToken(alias,keychain);
}
