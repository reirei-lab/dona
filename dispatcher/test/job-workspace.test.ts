import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {runProcess} from "../src/job-runtime.js";
import {JobWorkspace} from "../src/job-workspace.js";
import type {JobRow} from "../src/types.js";
import {tempConfig} from "./helpers.js";

test("Herdrを起動せずGit worktreeを作り、既存の変更を保持する",async()=>{
 const {root,config}=await tempConfig(),repo=path.join(config.jobsWorkspaceRoot,"github","owner","repo","repository"),worktree=path.join(config.jobsWorkspaceRoot,"github","owner","repo","worktrees","job_test");
 config.jobCommandTimeoutMs=10_000;
 await fs.mkdir(repo,{recursive:true});
 const git=(...args:string[])=>execFileSync(config.gitPath,["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 try{
  git("init");git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","fixture");git("remote","add","origin","https://github.com/owner/repo.git");git("update-ref","refs/dona/bases/job_test","HEAD");
  const row={job_id:"job_test",agent_name:"worker_test",workspace_path:worktree,workspace_json:JSON.stringify({kind:"github",repository:"owner/repo"})} as JobRow;
  const provider=new JobWorkspace(config);assert.equal((await provider.createGitHubWorktree(row,"owner/repo",undefined)).ok,true);
  await fs.writeFile(path.join(worktree,"keep.txt"),"user work");
  assert.equal((await provider.createGitHubWorktree(row,"owner/repo",undefined)).ok,true);
  assert.equal(await fs.readFile(path.join(worktree,"keep.txt"),"utf8"),"user work");
  execFileSync(config.gitPath,["-C",worktree,"switch","-c","unexpected-initial-branch"],{stdio:"pipe"});
  await assert.rejects(provider.createGitHubWorktree(row,"owner/repo",undefined),/branch mismatch/);
  git("remote","set-url","origin","https://github.com/owner/other.git");
  await assert.rejects(provider.createGitHubWorktree(row,"owner/repo",undefined),/origin does not match/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("入力なしの即時終了をEPIPEで失敗扱いせず、実入力の送信失敗は保持する",async()=>{
 for(let i=0;i<30;i++){
  const result=await runProcess("/bin/sh",["-c","exec 0<&-; printf ready"],5000);
  assert.equal(result.ok,true,result.stderr);assert.equal(result.stdout,"ready");
 }
 const sent=await runProcess("/bin/sh",["-c","exec 0<&-; sleep 0.05"],5000,undefined,false,"input".repeat(1000000));
 assert.equal(sent.ok,false);assert.match(sent.stderr,/EPIPE|pipe|closed/i);
});

for(const scenario of ["branch_only","different_base","registered_elsewhere"] as const)test(`worktree準備中断後の${scenario}を照合する`,async()=>{
 const {root,config}=await tempConfig(),repo=path.join(config.jobsWorkspaceRoot,"github","owner","repo","repository"),worktree=path.join(config.jobsWorkspaceRoot,"github","owner","repo","worktrees","job_retry");
 config.jobCommandTimeoutMs=10000;await fs.mkdir(repo,{recursive:true});
 const git=(...args:string[])=>execFileSync(config.gitPath,["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 try{
  git("init");git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","base");git("remote","add","origin","https://github.com/owner/repo.git");git("update-ref","refs/dona/bases/job_retry","HEAD");
  if(scenario==="different_base")git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","other");
  git("branch","dona/job_retry");
  if(scenario==="registered_elsewhere")git("worktree","add",path.join(root,"other"),"dona/job_retry");
  const row={job_id:"job_retry",agent_name:"worker_retry",workspace_path:worktree,workspace_json:JSON.stringify({kind:"github",repository:"owner/repo"})} as JobRow;
  const provider=new JobWorkspace(config);
  if(scenario==="branch_only"){
   assert.equal((await provider.createGitHubWorktree(row,"owner/repo",undefined)).ok,true);
   assert.equal(execFileSync(config.gitPath,["-C",worktree,"symbolic-ref","HEAD"],{encoding:"utf8"}).trim(),"refs/heads/dona/job_retry");
  }else await assert.rejects(provider.createGitHubWorktree(row,"owner/repo",undefined),scenario==="different_base"?/base_mismatch/:/worktree_registration/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

for(const scenario of ["branch","detached","foreign_repository","wrong_origin","symlink"] as const)test(`継続worktreeの${scenario}を照合し作業状態を保持する`,async()=>{
 const {root,config}=await tempConfig(),origin="job_"+"0".repeat(26),repo=path.join(config.jobsWorkspaceRoot,"github","owner","repo","repository"),worktree=path.join(path.dirname(repo),"worktrees",origin);
 config.jobCommandTimeoutMs=10000;
 const git=(cwd:string,...args:string[])=>execFileSync(config.gitPath,["-C",cwd,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 const initialize=async(dir:string)=>{await fs.mkdir(dir,{recursive:true});git(dir,"init");git(dir,"config","user.name","Test");git(dir,"config","user.email","test@example.invalid");git(dir,"commit","--allow-empty","-m","base");};
 try{
  await initialize(repo);git(repo,"remote","add","origin","https://github.com/owner/repo.git");
  let source=repo;
  if(scenario==="foreign_repository"){source=path.join(root,"foreign");await initialize(source);}
  git(source,"worktree","add","-b","approval-operations",worktree);
  if(scenario==="detached")git(worktree,"checkout","--detach");
  await fs.writeFile(path.join(worktree,"tracked"),"committed");git(worktree,"add","tracked");git(worktree,"commit","-m","progress");
  await fs.writeFile(path.join(worktree,"tracked"),"staged");git(worktree,"add","tracked");await fs.writeFile(path.join(worktree,"tracked"),"unstaged");await fs.writeFile(path.join(worktree,"untracked"),"keep");
  const head=git(worktree,"rev-parse","HEAD"),branch=git(worktree,"rev-parse","--abbrev-ref","HEAD"),status=git(worktree,"status","--porcelain"),index=git(worktree,"diff","--cached"),diff=git(worktree,"diff");
  const row={job_id:"job_"+"1".repeat(26),workspace_path:worktree,workspace_json:JSON.stringify({kind:"github",repository:"owner/repo",_dona_handoff:{workspace_job_id:origin}})} as JobRow;
  const provider=new JobWorkspace(config);
  if(scenario==="wrong_origin")git(repo,"remote","set-url","origin","https://github.com/owner/other.git");
  if(scenario==="symlink"){const moved=path.join(root,"moved");await fs.rename(worktree,moved);await fs.symlink(moved,worktree);}
  if(scenario==="foreign_repository")await assert.rejects(provider.verifyContinuationWorktree(row,"owner/repo"),/repository mismatch/);
  else if(scenario==="wrong_origin")await assert.rejects(provider.verifyContinuationWorktree(row,"owner/repo"),/handoff_repository_mismatch/);
  else if(scenario==="symlink")await assert.rejects(provider.verifyContinuationWorktree(row,"owner/repo"),/handoff_workspace_identity_invalid/);
  else await provider.verifyContinuationWorktree(row,"owner/repo");
  assert.equal(git(worktree,"rev-parse","HEAD"),head);assert.equal(git(worktree,"rev-parse","--abbrev-ref","HEAD"),branch);assert.equal(git(worktree,"status","--porcelain"),status);assert.equal(git(worktree,"diff","--cached"),index);assert.equal(git(worktree,"diff"),diff);
  assert.equal(await fs.readFile(path.join(worktree,"untracked"),"utf8"),"keep");
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
