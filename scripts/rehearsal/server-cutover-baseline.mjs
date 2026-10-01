// Executed inside the previous-release container, using that release's own wire schemas.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import * as contracts from "@hype-comms/contracts";

const origin = "http://127.0.0.1:3000";
let cookie;
async function request(method, path, responseSchema, body, requestSchema, headers = {}) {
  const response = await fetch(`${origin}/v1${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(requestSchema.parse(body)) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `Previous-release request failed (${method} ${path}, ${response.status})`);
  return { response, data: responseSchema.parse(await response.json()) };
}

const invitation = execFileSync(
  process.execPath,
  ["dist/modules/identity/invite-cli.js", "--email", "rehearsal@example.test"],
  { encoding: "utf8", timeout: 30_000, stdio: "pipe" },
);
const link = invitation.split("\n").find((line) => line.startsWith("https://"));
assert.ok(link);
const login = await request(
  "POST",
  "/auth/session",
  contracts.currentUserSchema,
  { token: new URL(link).searchParams.get("token") },
  contracts.verifyMagicLinkSchema,
);
cookie = login.response.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert.ok(cookie);
const initial = (await request("GET", "/bootstrap", contracts.workspaceBootstrapResponseSchema))
  .data;
assert.equal(typeof initial.syncCursor, "string", "The baseline must use the previous protocol");
const conversationId = initial.conversations.find((row) => row.conversation.slug === "general")
  ?.conversation.id;
assert.ok(conversationId);
const bytes = new TextEncoder().encode("Synthetic attachment 😀\n");
const contentSha256 = createHash("sha256").update(bytes).digest("hex");
const upload = (
  await request(
    "POST",
    "/files/uploads",
    contracts.createFileUploadResponseSchema,
    {
      conversationId,
      fileName: "rehearsal.txt",
      contentType: "text/plain",
      sizeBytes: bytes.length,
      contentSha256,
    },
    contracts.createFileUploadRequestSchema,
    { "idempotency-key": randomUUID() },
  )
).data;
const uploaded = await fetch(`${origin}/v1/files/${upload.attachment.id}/content`, {
  method: "PUT",
  headers: { cookie, "content-type": "text/plain", "x-content-sha256": contentSha256 },
  body: bytes,
  signal: AbortSignal.timeout(15_000),
});
assert.ok(uploaded.ok, "Previous-release attachment upload failed");
await request(
  "POST",
  `/files/${upload.attachment.id}/complete`,
  contracts.completeFileUploadResponseSchema,
  { sizeBytes: bytes.length, contentSha256 },
  contracts.completeFileUploadRequestSchema,
  { "idempotency-key": randomUUID() },
);
const clientMessageId = randomUUID();
const acceptedBody = contracts.sendConversationMessageRequestSchema.parse({
  clientMessageId,
  body: "Accepted before backup 😀",
  bodyFormat: "hype_comms_markdown_v1",
  threadRootId: null,
  mentionedUserIds: [],
  attachmentIds: [upload.attachment.id],
});
const accepted = (
  await request(
    "POST",
    `/conversations/${conversationId}/messages`,
    contracts.sendMessageResponseSchema,
    acceptedBody,
    contracts.sendConversationMessageRequestSchema,
    { "idempotency-key": clientMessageId },
  )
).data;
const task = (
  await request(
    "POST",
    `/conversations/${conversationId}/tasks`,
    contracts.taskMutationResponseSchema,
    { title: "Retained task", sourceMessageId: accepted.message.id },
    contracts.createTaskRequestSchema,
    { "idempotency-key": randomUUID() },
  )
).data;
const agent = (
  await request(
    "POST",
    "/agents",
    contracts.createAgentResponseSchema,
    { username: "rehearsal-agent", displayName: "Rehearsal agent" },
    contracts.createAgentRequestSchema,
  )
).data;
const credential = (
  await request(
    "POST",
    `/agents/${agent.agent.user.id}/tokens`,
    contracts.createAgentTokenResponseSchema,
    { label: "rehearsal" },
    contracts.createAgentTokenRequestSchema,
  )
).data;

// Captured in memory by the parent; never printed in rehearsal logs or durable evidence.
process.stdout.write(
  JSON.stringify({
    cookie,
    workspaceId: initial.workspace.id,
    conversationId,
    syncSequence: accepted.syncCursor,
    acceptedBody,
    acceptedMessageId: accepted.message.id,
    taskId: task.task.id,
    attachmentId: upload.attachment.id,
    agentToken: credential.token,
  }),
);
