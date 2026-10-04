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
