import type { SlackApiClient } from "./slack-api.js";

export type SocketOriginVisibility = "public_channel" | "private_channel" | "im" | "mpim" | "denied";

/** Socket Modeの受信workspaceだけで外部ユーザーの所属を推定しない。 */
export async function verifySocketActor(client: Pick<SlackApiClient, "getUser">, workspaceId: string, actorId: string, signal?: AbortSignal): Promise<boolean> {
  const user = await client.getUser(actorId, signal);
  return user.id === actorId && actorId !== "USLACKBOT" && user.teamId === workspaceId && user.stateKnown === true &&
    !user.isDeleted && !user.isBot && !user.isAppUser && user.isAgentforceBot !== true;
}

export async function socketOriginVisibility(client: Pick<SlackApiClient, "getChannel">, channelId: string, signal?: AbortSignal): Promise<SocketOriginVisibility | undefined> {
  const channel = await client.getChannel(channelId, signal);
  if (channel.id !== channelId || channel.isShared || channel.isArchived) return "denied";
  if (!channel.isIm && channel.visibilityKnown !== true) return undefined;
  return channel.isIm ? "im" : channel.isMpim ? "mpim" : channel.isPrivate ? "private_channel" : "public_channel";
}
