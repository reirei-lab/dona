#!/usr/bin/env node
import "dotenv/config";

import { SocketModeClient } from "@slack/socket-mode";

import { loadAdapterConfig } from "./adapter-config.js";
import { resolveSlackTokens } from "./credentials.js";
import { DispatcherClient } from "./dispatcher-client.js";
import { SlackHealthServer } from "./health-server.js";
import { MacOSKeychainStore } from "./keychain.js";
import { createSlackLogger, createSocketSdkLogger } from "./logger.js";
import { promptSecret } from "./prompt.js";
import { SlackSocketAdapter, type WorkspaceSocket } from "./socket-adapter.js";
import { SlackUpdateNotificationReporter } from "./update-notification.js";
import { SlackJobProgressReporter } from "./job-progress.js";
import { SlackWorkspaceRegistry } from "./workspace-registry.js";
import { SlackReminderConnector } from "./reminder-connector.js";
import { authorizeRuntimeCommand, readRuntimeIngressConfig, RuntimeCommandHttpIngress } from "./runtime-command-ingress.js";

async function main(): Promise<void> {
  const config = loadAdapterConfig();
  const keychain = new MacOSKeychainStore();
  const logger = createSlackLogger(config.logLevel);
  const sockets: WorkspaceSocket[] = [];

  for (const workspace of config.workspaces) {
    const tokens = await resolveSlackTokens(workspace, keychain, promptSecret);
    sockets.push({
      workspace,
      client: new SocketModeClient({
        appToken: tokens.appToken,
        logger: createSocketSdkLogger(logger, config.logLevel),
        autoReconnectEnabled: false,
        pingPongLoggingEnabled: false,
      }),
    });
  }

  const dispatcher = new DispatcherClient({
    socketPath: config.dispatcherSocketPath,
    connectTimeoutMs: config.dispatcherConnectTimeoutMs,
    timeoutMs: config.dispatcherTimeoutMs,
    internalTokenPath: config.updateInternalTokenPath,
  });
  const registry = await SlackWorkspaceRegistry.load(config.workspaces, keychain, logger);
  for(const socket of sockets) {
    const connection=registry.get(socket.workspace);socket.authenticatedTeamId=connection.teamId;
    socket.statusOriginVisibility=async (id,signal)=>{
      try {
        const channel=await connection.client.getChannel(id,signal);
        if(channel.id!==id||channel.isShared||channel.isArchived||(!channel.isIm&&channel.visibilityKnown!==true))return undefined;
        return channel.isIm?"im":channel.isMpim?"mpim":channel.isPrivate?"private_channel":"public_channel";
      } catch {return undefined;}
    };
  }
  const updateNotifications = new SlackUpdateNotificationReporter(registry);
  const adapter = new SlackSocketAdapter(sockets, dispatcher, config, logger);
  const health = new SlackHealthServer(
    config.healthSocketPath,
    adapter,
    dispatcher,
    logger,
    config.buildSha,
    updateNotifications,
    config.updateInternalTokenPath,
    new SlackReminderConnector(registry),
    new SlackJobProgressReporter(registry, (progressId, deliveryToken) => dispatcher.resolveJobProgress(progressId, deliveryToken)),
    config.appSchemaWrite,
    config.appSchemaReadMax,
  );
  const runtimeConfigPath = process.env.SLACK_RUNTIME_INGRESS_CONFIG;
  if (runtimeConfigPath) {
    await readRuntimeIngressConfig(runtimeConfigPath);
    const ingress = new RuntimeCommandHttpIngress({
      configured: async () => {
        const current = await readRuntimeIngressConfig(runtimeConfigPath);
        for (const workspace of current.workspaces) if (registry.get(workspace.alias).teamId !== workspace.team_id)
          throw Error("runtime_command_workspace_unverified");
        return current;
      },
      stopping: () => adapter.isStopping(),
      authorize: (request, signal) => authorizeRuntimeCommand(registry, request, signal),
      persist: (request, signal) => dispatcher.postRuntimeCommand(request, signal),
      ready: signal => dispatcher.runtimeCommandIngressReady(signal),
    });
    if (!await ingress.ready()) throw Error("runtime_command_ingress_not_ready");
    health.setRuntimeCommandIngress(ingress);
  }
  await health.start();
  try {
    await adapter.start();
  } catch (error) {
    await adapter.stop();
    await health.stop();
    throw error;
  }

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Stopping Slack Socket Mode Adapter", { signal });
    try {
      await adapter.stop();
      await health.stop();
    } catch (error) {
      logger.error("Slack Adapter graceful shutdown failed", {
        error_code: "shutdown_failed",
        error_message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.name === "ExitPromptError") {
    console.info("Tokenの入力を中断しました");
    process.exitCode = 130;
    return;
  }

  console.error("Failed to start Slack Socket Mode Adapter", error);
  process.exitCode = 1;
});
