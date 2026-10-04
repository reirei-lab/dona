import fs from "node:fs/promises";
import path from "node:path";
import type {DispatcherConfig} from "./config.js";
import type {JobRow} from "./types.js";
import type {HerdrCommandResult} from "./herdr.js";
import {workspaceJobId} from "./job-handoff.js";
import {jobWorkspaceLabel} from "./job-display-label.js";
import {runProcess,resolveCommitPrefix,commandError,safeCommandError,normalizedRepository,exists} from "./job-runtime.js";

/** Gitの成果保全・remote/base照合を維持し、pane生成を実行管理から切り離す。 */
export class JobWorkspace {
  constructor(private readonly config:DispatcherConfig){}
  private async workspaceCommand(args:string[],timeout:number,signal?:AbortSignal):Promise<HerdrCommandResult> {
    if(args[0]==="workspace")return {ok:true,stdout:"{}",stderr:"",exitCode:0,timedOut:false,aborted:false};
    if(args[0]!=="worktree"||args[1]!=="create")throw Error("workspace_command_invalid");
    const value=(key:string)=>{const i=args.indexOf(key);if(i<0||!args[i+1])throw Error("workspace_argument_missing");return args[i+1]!;};
    const cwd=value("--cwd"),branch=value("--branch"),target=value("--path"),base=value("--base");
    const existing=await runProcess(this.config.gitPath,["-C",cwd,"show-ref","--verify",`refs/heads/${branch}`],timeout,signal);
    if(existing.ok) {
      if(existing.stdout.trim().split(/\s+/)[0]!==base)throw Error("runtime_existing_branch_base_mismatch");
      const listed=await runProcess(this.config.gitPath,["-C",cwd,"worktree","list","--porcelain","-z"],timeout,signal);
      if(!listed.ok)throw commandError("Git worktree registration inspection failed",listed);
      const tokens=listed.stdout.split("\0");
      if(tokens.includes(`branch refs/heads/${branch}`)||tokens.includes(`worktree ${target}`))throw Error("runtime_existing_worktree_registration");
      if(await exists(target)) {
        const stat=await fs.lstat(target);
        if(stat.isSymbolicLink()||!stat.isDirectory()||(await fs.readdir(target)).length)throw Error("runtime_existing_worktree_content");
      }
      return runProcess(this.config.gitPath,["-C",cwd,"worktree","add",target,branch],timeout,signal);
    }
    // show-ref --verify は存在しないrefにも128を返すため、quietの終了値で不在を再確認する。
    const absent=await runProcess(this.config.gitPath,["-C",cwd,"show-ref","--verify","--quiet",`refs/heads/${branch}`],timeout,signal);
    if(absent.exitCode!==1||absent.timedOut||absent.aborted)throw commandError("Git branch absence could not be verified",absent);
    return runProcess(this.config.gitPath,["-C",cwd,"worktree","add","-b",branch,target,base],timeout,signal);
  }
  async createGitHubWorktree(
    row: JobRow,
    repository: string,
    requestedBaseRef: string | undefined,
    signal?: AbortSignal,
  ): Promise<HerdrCommandResult> {
    const [owner, repo] = repository.split("/") as [string, string];
    const repositoryPath = path.join(this.config.jobsWorkspaceRoot, "github", owner, repo, "repository");
    await fs.mkdir(path.dirname(repositoryPath), { recursive: true, mode: 0o700 });
    if (!(await exists(path.join(repositoryPath, ".git")))) {
      if (await exists(repositoryPath)) {
        const entries = await fs.readdir(repositoryPath);
        if (entries.length > 0) throw new Error(`Repository path is not an empty Git repository: ${repositoryPath}`);
      }
      const cloned = await runProcess(
        this.config.ghPath,
        ["repo", "clone", repository, repositoryPath],
        120_000,
        signal,
      );
      if (!cloned.ok) throw commandError("GitHub repository clone failed", cloned);
    }
    const origin = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "remote", "get-url", "origin"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    if (!origin.ok) throw commandError("Git origin inspection failed", origin);
    if (normalizedRepository(origin.stdout) !== repository.toLowerCase()) {
      throw new Error(`Existing repository origin does not match ${repository}`);
    }
    if (await exists(path.join(row.workspace_path, ".git"))) {
      await this.verifyExistingWorktreeIdentity(row, repositoryPath, signal);
      return this.workspaceCommand([
        "workspace", "create", "--cwd", row.workspace_path, "--label", jobWorkspaceLabel(row.workspace_json, row.agent_name), "--no-focus",
      ], this.config.jobCommandTimeoutMs + 5_000, signal);
    }
    const persistedBaseRef = `refs/dona/bases/${row.job_id}`;
    const persistedBase = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "rev-parse", "--verify", `${persistedBaseRef}^{commit}`],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const persistedBaseSha = persistedBase.stdout.trim();
    if (persistedBase.ok && /^[0-9a-f]{40,64}$/i.test(persistedBaseSha)) {
      const created = await this.workspaceCommand([
        "worktree", "create",
        "--cwd", repositoryPath,
        "--branch", `dona/${row.job_id}`,
        "--base", persistedBaseSha,
        "--path", row.workspace_path,
        "--label", jobWorkspaceLabel(row.workspace_json, row.agent_name),
        "--no-focus",
      ], 120_000, signal);
      if (!created.ok) throw commandError("Git worktree creation failed", created);
      await this.verifyWorktreeIdentity(row, repositoryPath, persistedBaseSha, signal);
      return created;
    }
    let baseBranch = requestedBaseRef;
    const upstream = baseBranch?.match(/^(.*?)@\{(upstream|u|push)\}$/i) ?? undefined;
    const upstreamKind = upstream?.[2]?.toLowerCase();
    if (baseBranch === "origin" || baseBranch === "origin/HEAD") {
      const sameNameTag = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "ls-remote", "--exit-code", "--refs", "--tags", "origin", `refs/tags/${baseBranch}`],
        120_000,
        signal,
      );
      if (sameNameTag.ok && sameNameTag.stdout.trim()) {
        throw new Error(`GitHub base ref ${baseBranch} is ambiguous with a remote tag`);
      }
      if (!sameNameTag.ok && sameNameTag.exitCode !== 2) {
        throw safeCommandError("Git remote tag ambiguity check failed", sameNameTag);
      }
    }
    const usesDefaultBranch = !baseBranch || baseBranch === "@" || baseBranch === "HEAD" || baseBranch === "FETCH_HEAD" || baseBranch === "origin"
      || baseBranch === "origin/HEAD" || baseBranch === "remotes/origin/HEAD" || baseBranch === "refs/remotes/origin/HEAD"
      || (upstream !== undefined && !upstream[1]);
    if (usesDefaultBranch) {
      const viewed = await runProcess(
        this.config.ghPath,
        ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        120_000,
        signal,
      );
      if (!viewed.ok || !viewed.stdout.trim()) throw commandError("GitHub default branch lookup failed", viewed);
      baseBranch = `refs/heads/${viewed.stdout.trim()}`;
    } else if (upstream) {
      const branchName = upstream[1];
      const [trackedRemote, trackedMerge] = await Promise.all([
        runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "config", "--get", `branch.${branchName}.remote`],
          this.config.jobCommandTimeoutMs,
          signal,
        ),
        runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "config", "--get-all", `branch.${branchName}.merge`],
          this.config.jobCommandTimeoutMs,
          signal,
        ),
      ]);
      const mergeRef = trackedMerge.stdout.trim().split("\n")[0] ?? "";
      if (upstreamKind !== "push") {
        if (!trackedRemote.ok || trackedRemote.stdout.trim() !== "origin" || !trackedMerge.ok || !mergeRef.startsWith("refs/heads/")) {
          throw new Error(`GitHub base ref ${baseBranch} does not resolve to an origin branch`);
        }
        baseBranch = mergeRef;
      } else {
        const [branchPushRemote, defaultPushRemote, pushDefault, configuredPush] = await Promise.all([
          runProcess(
            this.config.gitPath,
            ["-C", repositoryPath, "config", "--get", `branch.${branchName}.pushRemote`],
            this.config.jobCommandTimeoutMs,
            signal,
          ),
          runProcess(
            this.config.gitPath,
            ["-C", repositoryPath, "config", "--get", "remote.pushDefault"],
            this.config.jobCommandTimeoutMs,
            signal,
          ),
          runProcess(
            this.config.gitPath,
            ["-C", repositoryPath, "config", "--get", "push.default"],
            this.config.jobCommandTimeoutMs,
            signal,
          ),
          runProcess(
            this.config.gitPath,
            ["-C", repositoryPath, "config", "--get-all", "remote.origin.push"],
            this.config.jobCommandTimeoutMs,
            signal,
          ),
        ]);
        const pushRemote = branchPushRemote.ok && branchPushRemote.stdout.trim()
          ? branchPushRemote.stdout.trim()
          : defaultPushRemote.ok && defaultPushRemote.stdout.trim()
            ? defaultPushRemote.stdout.trim()
            : trackedRemote.ok && trackedRemote.stdout.trim()
              ? trackedRemote.stdout.trim()
              : "origin";
        const mode = pushDefault.ok && pushDefault.stdout.trim() ? pushDefault.stdout.trim() : "simple";
        if (pushRemote !== "origin" || configuredPush.ok) {
          throw new Error(`GitHub base ref ${baseBranch} does not resolve to an origin branch`);
        }
        if ((mode === "upstream" || mode === "tracking") && trackedRemote.ok && trackedRemote.stdout.trim() === pushRemote
          && trackedMerge.ok && mergeRef.startsWith("refs/heads/")) baseBranch = mergeRef;
        else if (mode === "current") baseBranch = `refs/heads/${branchName}`;
        else if (mode === "matching") baseBranch = `refs/heads/${branchName}`;
        else if (mode === "simple" && trackedRemote.ok && trackedMerge.ok && trackedRemote.stdout.trim() === pushRemote && mergeRef === `refs/heads/${branchName}`) {
          baseBranch = mergeRef;
        } else {
          throw new Error(`GitHub base ref ${baseBranch} does not resolve to an origin branch`);
        }
      }
    }
    if (!baseBranch) throw new Error("GitHub base ref could not be resolved");
    if (baseBranch.startsWith("origin/") && baseBranch !== "origin/HEAD") {
      const branchName = baseBranch.slice("origin/".length);
      const advertised = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "ls-remote", "--refs", "origin", `refs/heads/${branchName}`, `refs/tags/${baseBranch}`],
        120_000,
        signal,
      );
      if (!advertised.ok) throw safeCommandError(`Git remote base ref ${baseBranch} could not be inspected`, advertised);
      const advertisedRefs = advertised.stdout.trim().split("\n").map((line) => line.split("\t")[1]).filter(Boolean);
      const hasBranch = advertisedRefs.includes(`refs/heads/${branchName}`);
      const hasTag = advertisedRefs.includes(`refs/tags/${baseBranch}`);
      if (hasBranch && hasTag) throw new Error(`Git remote base ref ${baseBranch} is ambiguous`);
      if (hasTag) baseBranch = `refs/tags/${baseBranch}`;
      else if (hasBranch) baseBranch = `refs/heads/${branchName}`;
      else throw new Error(`Git remote base ref ${baseBranch} was not found`);
    }
    const explicitTag = baseBranch.startsWith("refs/tags/")
      ? baseBranch
      : baseBranch.startsWith("tags/")
        ? `refs/${baseBranch}`
        : undefined;
    const explicitBranch = baseBranch.startsWith("refs/heads/")
      ? baseBranch.slice("refs/heads/".length)
      : baseBranch.startsWith("heads/")
        ? baseBranch.slice("heads/".length)
      : baseBranch.startsWith("refs/remotes/origin/")
        ? baseBranch.slice("refs/remotes/origin/".length)
        : baseBranch.startsWith("remotes/origin/")
          ? baseBranch.slice("remotes/origin/".length)
        : baseBranch.startsWith("origin/")
          ? baseBranch.slice("origin/".length)
          : undefined;
    let sourceRef: string;
    let fetchedRef: string;
    if (explicitTag) {
      sourceRef = explicitTag;
      fetchedRef = `refs/dona/bases/${row.job_id}`;
    } else if (explicitBranch) {
      sourceRef = `refs/heads/${explicitBranch}`;
      fetchedRef = `refs/dona/bases/${row.job_id}`;
    } else {
      const checked = await runProcess(
        this.config.gitPath,
        ["check-ref-format", "--branch", baseBranch],
        120_000,
        signal,
      );
      if (!checked.ok) throw new Error("GitHub base ref name is invalid");
      const advertised = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "ls-remote", "--refs", "origin", `refs/heads/${baseBranch}`, `refs/tags/${baseBranch}`],
        120_000,
        signal,
      );
      if (!advertised.ok) throw safeCommandError(`Git remote base ref ${baseBranch} could not be inspected`, advertised);
      const advertisedRefs = advertised.stdout.trim().split("\n").map((line) => line.split("\t")[1]).filter(Boolean);
      const hasBranch = advertisedRefs.includes(`refs/heads/${baseBranch}`);
      const hasTag = advertisedRefs.includes(`refs/tags/${baseBranch}`);
      if (hasBranch && hasTag) throw new Error(`Git remote base ref ${baseBranch} is ambiguous`);
      let resolvedObject: string | undefined;
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseBranch)) {
        try {
          resolvedObject = await this.resolveRemoteCommit(repositoryPath, baseBranch, row, signal);
        } catch (error) {
          if (!(error instanceof Error && error.message === `Git remote commit ${baseBranch} was not uniquely resolved` && (hasBranch || hasTag))) {
            throw error;
          }
        }
      }
      if (resolvedObject) {
        sourceRef = resolvedObject;
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else if (hasBranch) {
        sourceRef = `refs/heads/${baseBranch}`;
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else if (hasTag) {
        sourceRef = `refs/tags/${baseBranch}`;
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else if (/^[0-9a-f]{4,64}$/i.test(baseBranch)) {
        sourceRef = await this.resolveRemoteCommit(repositoryPath, baseBranch, row, signal);
        fetchedRef = `refs/dona/bases/${row.job_id}`;
      } else {
        throw new Error(`Git remote base ref ${baseBranch} was not found`);
      }
    }
    const refspec = `+${sourceRef}:${fetchedRef}`;
    const fetched = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "fetch", "--refmap=", "--prune", "origin", refspec],
      120_000,
      signal,
    );
    if (!fetched.ok) throw safeCommandError(`Git fetch failed for ref ${baseBranch}`, fetched);
    const resolved = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "rev-parse", "--verify", `${fetchedRef}^{commit}`],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const baseSha = resolved.stdout.trim();
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
      throw safeCommandError(`Git remote base ref ${baseBranch} was not found`, resolved);
    }
    const created = await this.workspaceCommand([
      "worktree", "create",
      "--cwd", repositoryPath,
      "--branch", `dona/${row.job_id}`,
      "--base", baseSha,
      "--path", row.workspace_path,
      "--label", jobWorkspaceLabel(row.workspace_json, row.agent_name),
      "--no-focus",
    ], 120_000, signal);
    if (!created.ok) throw commandError("Git worktree creation failed", created);
    await this.verifyWorktreeIdentity(row, repositoryPath, baseSha, signal);
    return created;
  }

  async verifyContinuationWorktree(row: JobRow, repository: string, signal?: AbortSignal): Promise<void> {
    const originId = workspaceJobId(row);
    const repositoryPath = path.join(this.config.jobsWorkspaceRoot, "github", ...repository.split("/"), "repository");
    const expectedPath = path.join(path.dirname(repositoryPath), "worktrees", originId);
    if (row.workspace_path !== expectedPath || (await fs.lstat(expectedPath)).isSymbolicLink()) throw new Error("handoff_workspace_identity_invalid");
    const origin = await runProcess(this.config.gitPath, ["-C", repositoryPath, "remote", "get-url", "origin"], this.config.jobCommandTimeoutMs, signal);
    if (!origin.ok || normalizedRepository(origin.stdout) !== repository.toLowerCase()) throw new Error("handoff_repository_mismatch");
    const head = await runProcess(this.config.gitPath, ["-C", row.workspace_path, "rev-parse", "--verify", "HEAD^{commit}"], this.config.jobCommandTimeoutMs, signal);
    if (!head.ok) throw new Error("handoff_head_unavailable");
    // 継続先の所有権はpathとrepositoryで照合する。workerが選んだbranch/HEADは保持する。
    await this.verifyWorktreeIdentity({ ...row, job_id: originId }, repositoryPath, head.stdout.trim(), signal, "continuation");
  }

  private async verifyExistingGitHubWorktree(
    row: JobRow,
    repository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const [owner, repo] = repository.split("/") as [string, string];
    const repositoryPath = path.join(this.config.jobsWorkspaceRoot, "github", owner, repo, "repository");
    const origin = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "remote", "get-url", "origin"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    if (!origin.ok || normalizedRepository(origin.stdout) !== repository.toLowerCase()) {
      throw new Error(`Existing repository origin does not match ${repository}`);
    }
    await this.verifyExistingWorktreeIdentity(row, repositoryPath, signal);
  }

  private async verifyExistingWorktreeIdentity(
    row: JobRow,
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const baseRef = `refs/dona/bases/${row.job_id}`;
    let resolved = await runProcess(
      this.config.gitPath,
      ["-C", repositoryPath, "rev-parse", "--verify", `${baseRef}^{commit}`],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    let expectedSha = resolved.stdout.trim();
    let migrateLegacyRef = false;
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(expectedSha)) {
      const legacyRef = `refs/heads/dona/${row.job_id}`;
      resolved = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-parse", "--verify", `${legacyRef}^{commit}`],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      expectedSha = resolved.stdout.trim();
      migrateLegacyRef = true;
    }
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(expectedSha)) {
      throw safeCommandError(`Existing job branch dona/${row.job_id} could not be resolved`, resolved);
    }
    await this.verifyWorktreeIdentity(row, repositoryPath, expectedSha, signal);
    if (migrateLegacyRef) {
      const persisted = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "update-ref", baseRef, expectedSha],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      if (!persisted.ok) throw safeCommandError("Existing job base identity could not be migrated", persisted);
    }
  }

  private async resolveRemoteCommit(
    repositoryPath: string,
    baseRef: string,
    row: JobRow,
    signal?: AbortSignal,
  ): Promise<string> {
    const objectNamespace = `refs/dona/objects/${row.job_id}`;
    try {
      const fetchedObjects = await runProcess(
        this.config.gitPath,
        [
          "-C", repositoryPath, "fetch", "--refmap=", "--prune", "origin",
          `+refs/heads/*:${objectNamespace}/heads/*`,
          `+refs/tags/*:${objectNamespace}/tags/*`,
        ],
        120_000,
        signal,
      );
      if (!fetchedObjects.ok) throw safeCommandError(`Git remote commit ${baseRef} could not be fetched`, fetchedObjects);
      const remoteObjects = await resolveCommitPrefix(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-list", "--objects", `--glob=${objectNamespace}/*`],
        baseRef,
        120_000,
        signal,
      );
      if (!remoteObjects.ok) throw safeCommandError("Git remote commit candidates could not be inspected", remoteObjects);
      const candidates = remoteObjects.candidates;
      if (candidates.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(candidates[0] ?? "")) {
        throw new Error(`Git remote commit ${baseRef} was not uniquely resolved`);
      }
      const peeled = await runProcess(
        this.config.gitPath,
        ["-C", repositoryPath, "rev-parse", "--verify", `${candidates[0]}^{commit}`],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      const commit = peeled.stdout.trim();
      if (!peeled.ok || !/^[0-9a-f]{40,64}$/i.test(commit)) {
        throw new Error(`Git remote commit ${baseRef} does not identify a commit`);
      }
      return commit;
    } finally {
      while (true) {
        const listedRefs = await runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "for-each-ref", "--count=100", "--format=%(refname)", objectNamespace],
          this.config.jobCommandTimeoutMs,
        );
        if (!listedRefs.ok) throw safeCommandError("Git temporary ref inspection failed", listedRefs);
        const temporaryRefs = listedRefs.stdout.trim().split("\n").filter(Boolean);
        if (temporaryRefs.length === 0) break;
        const deleted = await runProcess(
          this.config.gitPath,
          ["-C", repositoryPath, "update-ref", "--stdin"],
          this.config.jobCommandTimeoutMs,
          undefined,
          false,
          temporaryRefs.map((temporaryRef) => `delete ${temporaryRef}\n`).join(""),
        );
        if (!deleted.ok) throw safeCommandError("Git temporary ref cleanup failed", deleted);
      }
    }
  }

  private async verifyWorktreeIdentity(
    row: JobRow,
    repositoryPath: string,
    expectedSha: string,
    signal?: AbortSignal,
    mode: "initial" | "continuation" = "initial",
  ): Promise<void> {
    const head = await runProcess(
      this.config.gitPath,
      ["-C", row.workspace_path, "rev-parse", "--verify", "HEAD^{commit}"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const actualSha = head.stdout.trim();
    if (!head.ok || actualSha !== expectedSha) {
      throw new Error(`Git worktree HEAD mismatch for dona/${row.job_id}: expected ${expectedSha}, got ${actualSha || "unresolved"}`);
    }
    if (mode === "initial") {
      const branch = await runProcess(
        this.config.gitPath,
        ["-C", row.workspace_path, "symbolic-ref", "--quiet", "HEAD"],
        this.config.jobCommandTimeoutMs,
        signal,
      );
      const expectedBranch = `refs/heads/dona/${row.job_id}`;
      if (!branch.ok || branch.stdout.trim() !== expectedBranch) {
        throw new Error(`Git worktree branch mismatch for dona/${row.job_id}`);
      }
    }
    const commonDir = await runProcess(
      this.config.gitPath,
      ["-C", row.workspace_path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.config.jobCommandTimeoutMs,
      signal,
    );
    const actualCommonDir = commonDir.ok ? await fs.realpath(commonDir.stdout.trim()).catch(() => "") : "";
    const expectedCommonDir = await fs.realpath(path.join(repositoryPath, ".git")).catch(() => "");
    if (!actualCommonDir || actualCommonDir !== expectedCommonDir) {
      throw new Error(`Git worktree repository mismatch for dona/${row.job_id}`);
    }
  }
}
