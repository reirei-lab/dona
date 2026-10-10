import type { SlackApiClient } from "./slack-api.js";

export type SocketOriginVisibility = "public_channel" | "private_channel" | "im" | "mpim" | "denied";

/** Socket Modeの受信workspaceだけで外部ユーザーの所属を推定しない。 */
export async function verifySocketActor(client: Pick<SlackApiClient, "getUser">, workspaceId: string, actorId: string, signal?: AbortSignal): Promise<boolean> {
  const user = await client.getUser(actorId, signal);
  return user.id === actorId && actorId !== "USLACKBOT" && (user.teamId === workspaceId || user.enterpriseTeamIds?.includes(workspaceId) === true) && user.stateKnown === true &&
    user.isSuspended !== true && !user.isDeleted && !user.isBot && !user.isAppUser && user.isAgentforceBot !== true;
}

export async function socketOriginVisibility(client: Pick<SlackApiClient, "getChannel">, channelId: string, signal?: AbortSignal): Promise<SocketOriginVisibility | undefined> {
  const channel = await client.getChannel(channelId, signal);
  if (channel.id !== channelId || channel.isShared || channel.isArchived) return "denied";
  if (!channel.isIm && channel.visibilityKnown !== true) return undefined;
  return channel.isIm ? "im" : channel.isMpim ? "mpim" : channel.isPrivate ? "private_channel" : "public_channel";
}

/** workspace接続ごとに短期共有する。期限後の失敗で古い許可を延長しない。 */
export function createSocketActorVerifier(client: Pick<SlackApiClient, "getUser">, workspaceId: string, now = () => performance.now()) {
  const cache = new Map<string, { value: boolean; expiresAt: number }>();
  const pending = new Map<string, Promise<boolean | undefined>>();
  return async (actorId: string): Promise<boolean | undefined> => {
    const cached = cache.get(actorId);
    if (cached && cached.expiresAt > now()) return cached.value;
    cache.delete(actorId);
    const existing = pending.get(actorId);
    if (existing) return existing;
    // 同時照会にも上限を設け、未完了Promiseでメモリを無制限に占有しない。
    if (pending.size >= 1000) return undefined;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const read = Promise.race([
      verifySocketActor(client, workspaceId, actorId, controller.signal),
      new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 450); }),
    ]).catch(() => undefined).then(value => {
      // 一時失敗は確定否認と区別し、再配送の本人確認を妨げない。
      if (value === undefined) return undefined;
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      // 許可は最長30秒、確定否認は5秒。期限後は必ず再検証する。
      cache.set(actorId, { value, expiresAt: now() + (value ? 30_000 : 5_000) });
      return value;
    }).finally(() => { clearTimeout(timer); pending.delete(actorId); });
    pending.set(actorId, read);
    return read;
  };
}
