#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {resolveLocalApprovalInstallConfig} from "./local-approval-install-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(scriptDir);
const destination = process.argv[2];
const sha = process.argv[3];
if (!destination || !path.isAbsolute(destination) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
  throw new Error("Usage: render-self-update-templates.mjs <absolute-destination> <full-sha>");
}

const command = (name, fallback) => {
  try {
    return fs.realpathSync(execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim());
  } catch {
    if (fallback && fs.existsSync(fallback)) return fs.realpathSync(fallback);
    throw new Error(`Required executable not found: ${name}`);
  }
};
const base = process.argv[4] ?? path.join(os.homedir(), "Library", "Application Support", "Dona");
const generation = process.argv[5] === "generation";
if (!path.isAbsolute(base) || path.normalize(base) !== base || (process.argv[5] && !generation)) {
  throw new Error("Invalid target root");
}
const values = {
  NODE: fs.realpathSync(process.execPath),
  NPM: command("npm"),
  GH: command("gh"),
  GIT: command("git", "/usr/bin/git"),
  HERDR: command("herdr"),
  CODEX: command("codex"),
  CONTROL_ROOT: path.join(base, generation ? "control" : "update-control"),
  RUNTIME_ROOT: path.join(base, "runtime"),
  CONFIG_ROOT: path.join(base, "config"),
  LOG_ROOT: path.join(base, "logs"),
  INSTALL_SHA: sha,
};
const compatibilityFile = JSON.parse(fs.readFileSync(
  path.join(repository, "config", "release-compatibility.json"),
  "utf8",
));
if (compatibilityFile.schema_version !== 1) throw new Error("Unsupported release compatibility schema");
const { schema_version: _compatibilitySchema, ...compatibility } = compatibilityFile;
const transitionFile = JSON.parse(fs.readFileSync(
  path.join(repository, "config", "update-compatibility-transitions.json"),
  "utf8",
));
if (transitionFile.schema_version !== 1 || !Array.isArray(transitionFile.transitions)) {
  throw new Error("Unsupported compatibility transition schema");
}

let signedHost;
const hostInput=process.argv[6];
const existingPolicy=path.join(values.CONTROL_ROOT,"policy.json");
if(hostInput || fs.existsSync(existingPolicy)) {
  const file=hostInput || existingPolicy, info=fs.lstatSync(file);
  if(!path.isAbsolute(file)||!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error("signed_host_config_not_private");
  const input=JSON.parse(fs.readFileSync(file,"utf8"));signedHost=hostInput?input:input.signed_host;
  if((hostInput&&!signedHost)||((hostInput||signedHost)&&(info.mode&0o077)!==0))throw Error("signed_host_config_not_private");
  if(signedHost && (Object.keys(signedHost).sort().join(',')!=='access_group,provisioning_profile,signing_identity_sha1,team_id'||
    !/^[A-Z0-9]{10}$/.test(signedHost.team_id)||!(/^[A-Z0-9]{10}\.dev\.dona\.approval$/).test(signedHost.access_group)||
    !/^[a-fA-F0-9]{40}$/.test(signedHost.signing_identity_sha1)||!path.isAbsolute(signedHost.provisioning_profile)))throw Error("signed_host_config_invalid");
}
const taskInput=process.argv[7];
if(taskInput && taskInput!=="forward_only")throw Error("task_generation_update_mode_invalid");
let taskGenerationUpdate;
if(fs.existsSync(existingPolicy)){
 const info=fs.lstatSync(existingPolicy);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid())throw Error("existing_policy_not_private");
 taskGenerationUpdate=JSON.parse(fs.readFileSync(existingPolicy,"utf8")).task_generation_update;
 if(taskGenerationUpdate&&(info.mode&0o077))throw Error("existing_policy_not_private");
}
const expectedTaskMode={mode:"forward_only",schema:4,task_execution_version:1};
if(taskInput)taskGenerationUpdate=expectedTaskMode;
if(taskGenerationUpdate && (Object.keys(taskGenerationUpdate).sort().join(',')!=="mode,schema,task_execution_version"||Object.entries(expectedTaskMode).some(([k,v])=>taskGenerationUpdate[k]!==v)))throw Error("task_generation_update_mode_invalid");
const localApprovalConfig=resolveLocalApprovalInstallConfig(process.argv[8],process.argv[9],values.CONFIG_ROOT);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
for (const name of ["dev.dona.updater", "dev.dona.dispatcher", "dev.dona.slack-adapter"]) {
  let body = fs.readFileSync(path.join(repository, "launchd", `${name}.plist.in`), "utf8");
  for (const [key, value] of Object.entries(values)) body = body.replaceAll(`__${key}__`, xml(value));
  if(name==="dev.dona.dispatcher" && signedHost && (!fs.existsSync(path.join(values.RUNTIME_ROOT,"current")) || fs.existsSync(path.join(values.RUNTIME_ROOT,"current/signed-host/DonaDispatcher.app")))) body=body.replace(
    `<string>${xml(values.NODE)}</string>\n    <string>${xml(values.RUNTIME_ROOT)}/current/dispatcher/dist/cli.js</string>`,
    `<string>${xml(values.RUNTIME_ROOT)}/current/signed-host/DonaDispatcher.app/Contents/MacOS/DonaDispatcher</string>`);
  if(name==="dev.dona.dispatcher" && localApprovalConfig) body=body.replace(
    "<key>EnvironmentVariables</key>\n  <dict>",
    `<key>EnvironmentVariables</key>\n  <dict>\n    <key>DONA_LOCAL_APPROVAL_CONFIG</key><string>${xml(localApprovalConfig)}</string>`);
  if (/__[A-Z_]+__/.test(body)) throw new Error(`Unresolved template token in ${name}`);
  fs.writeFileSync(path.join(destination, `${name}.plist`), body, { mode: 0o600 });
}

if(signedHost)fs.writeFileSync(path.join(destination,"signed-host.json"),JSON.stringify(signedHost),{mode:0o600});
const policy = {
  ...(taskGenerationUpdate ? {task_generation_update:taskGenerationUpdate} : {}),
  ...(signedHost ? {signed_host:signedHost} : {}),
  schema_version: 1,
  policy_version: "2026-09-03.2",
  repository: "hiragram/dona",
  canonical_remote: "https://github.com/hiragram/dona.git",
  default_branch: "main",
  control_root: values.CONTROL_ROOT,
  config_root: values.CONFIG_ROOT,
  release_root: path.join(values.RUNTIME_ROOT, "releases"),
  current_pointer: path.join(values.RUNTIME_ROOT, "current"),
  previous_pointer: path.join(values.RUNTIME_ROOT, "previous"),
  dispatcher_socket: path.join(base, "run", generation ? "d.sock" : "dispatcher.sock"),
  slack_socket: path.join(base, "run", generation ? "s.sock" : "slack-adapter.sock"),
  dispatcher_internal_token_file: path.join(values.CONTROL_ROOT, "dispatcher.token"),
  main_agent: { session: "dona", name: "dona-main", minimum_herdr_version: "0.8.2" },
  launchd: { dispatcher_label: "dev.dona.dispatcher", slack_label: "dev.dona.slack-adapter" },
  executables: {
    git: values.GIT, npm: values.NPM, node: values.NODE, launchctl: "/bin/launchctl", gh: values.GH, herdr: values.HERDR, codex: values.CODEX,
  },
  timeouts: {
    command_ms: 900000, health_ms: 30000, drain_ms: 30000, agent_drain_ms: 900000,
    agent_exit_ms: 30000, agent_start_ms: 60000, reconcile_ms: 300000, lease_ms: 60000,
  },
  output_limit_bytes: 1048576,
  diagnostic_log_limit_bytes: 8388608,
  diagnostic_aggregate_limit_bytes: 67108864,
  diagnostic_retention_days: 14,
  disk_floor_bytes: 2147483648,
  retain_successful: 2,
  required_checks: ["Verify dispatcher", "Verify sources/slack", "Verify updater", "Verify self-hosted macOS", "Verify sources/web"],
  require_verified_signature: false,
  compatibility,
  compatibility_transitions: transitionFile.transitions,
};
fs.writeFileSync(path.join(destination, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
