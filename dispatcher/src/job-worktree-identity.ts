import fs from "node:fs/promises";
import path from "node:path";

/** common directoryだけでなく、worktree固有のindex/HEADと元pathの対応を照合する。 */
export async function assertLinkedWorktreeRegistration(workspace:string,gitDirectory:string,commonDirectory:string):Promise<void> {
  try {
    const dotGit=path.join(await fs.realpath(workspace),".git"),stat=await fs.lstat(dotGit);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("not a linked worktree");
    const metadata=await fs.realpath(gitDirectory),registrations=await fs.realpath(path.join(commonDirectory,"worktrees"));
    if(path.dirname(metadata)!==registrations)throw Error("not a registered worktree");
    const backpointer=(await fs.readFile(path.join(metadata,"gitdir"),"utf8")).trim();
    if(!backpointer||await fs.realpath(path.resolve(metadata,backpointer))!==dotGit)throw Error("worktree backpointer differs");
  } catch {throw Error("handoff_worktree_registration_mismatch");}
}
