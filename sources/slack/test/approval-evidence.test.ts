import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackWebApiClient } from "../src/slack-api.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
test("provider SDK経路はmetadata/full cursor契約を要求し本文とprivate URLを投影しない", async () => {
  const client = new SlackWebApiClient("fixture_only_unused_token", logger);
  const internal = (client as unknown as { client: { conversations: { replies: (args: unknown) => Promise<unknown> } } }).client;
  let received: unknown;
  internal.conversations.replies = async args => {
    received = args;
    return { messages: [{ ts: "1234567890.123457", thread_ts: "1234567890.123456", user: "Ubot", bot_id: "Bbot",
      metadata: { event_type: "dona_approval_notification_v1", event_payload: { mac: "fixture" } },
      text: "fixture_only_private_body", files: [{ url_private: "fixture_only_private_url" }] }],
      has_more: true, response_metadata: { next_cursor: "next" } };
  };
  const result = await client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000", "previous");
  assert.deepEqual(received, { channel: "C123", ts: "1234567890.123456", latest: "1234567900.000000", inclusive: true,
    include_all_metadata: true, limit: 100, cursor: "previous" });
  assert.equal(result.hasMore, true); assert.equal(result.nextCursor, "next");
  assert.equal(JSON.stringify(result).includes("private_body"), false); assert.equal(JSON.stringify(result).includes("private_url"), false);
  internal.conversations.replies = async () => ({ messages: [] });
  assert.equal((await client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000")).hasMore, false);
  for (const next_cursor of ["", null]) {
    internal.conversations.replies = async () => ({ messages: [], response_metadata: { next_cursor } });
    assert.equal((await client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000")).hasMore, false);
  }
  internal.conversations.replies = async () => ({ messages: [], response_metadata: { next_cursor: "next" } });
  assert.equal((await client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000")).hasMore, true);
  internal.conversations.replies = async () => ({});
  await assert.rejects(client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000"));
  internal.conversations.replies = async () => ({ messages: [], has_more: true });
  await assert.rejects(client.getApprovalEvidencePage("C123", "1234567890.123456", "1234567900.000000"));
});
