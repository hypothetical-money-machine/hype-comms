import { describe, expect, it } from "vitest";

import { MAX_RENDERED_CONTEXT_BYTES, cliAdapterContextSchema } from "../src/adapter-protocol.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-07-21T12:00:00.000Z";

const message = {
  id: MESSAGE_ID,
  conversationSequence: "1",
  createdAt: NOW,
  body: "Hello",
  author: {
    id: USER_ID,
    kind: "human",
    username: "morgan",
    displayName: "Morgan",
  },
  mentionedYou: false,
  threadRootId: null,
} as const;

const contextPack = {
  version: 1,
  conversation: {
    id: CONVERSATION_ID,
    kind: "direct_message",
    selector: "@morgan",
    peer: message.author,
    self: false,
  },
  anchorMessageId: MESSAGE_ID,
  messages: [message],
  threadRoot: null,
  replyTarget: { kind: "flat", conversationId: CONVERSATION_ID },
  readThroughMessageId: MESSAGE_ID,
  truncatedBefore: false,
  nextCursor: null,
} as const;

describe("CLI adapter context contract", () => {
  it("bounds the rendered context in UTF-8 bytes, not UTF-16 code units", () => {
    // Three UTF-8 bytes per code unit, so this is comfortably under the limit when counted the
    // way JavaScript counts string length and comfortably over it on the wire. The Hermes adapter
    // measures the encoded bytes, so a schema counting code units would pass a pack the adapter
    // then rejects as an invalid context pack.
    const overInBytes = "あ".repeat(400_000);
    expect(overInBytes.length).toBeLessThan(MAX_RENDERED_CONTEXT_BYTES);
    expect(new TextEncoder().encode(overInBytes).byteLength).toBeGreaterThan(
      MAX_RENDERED_CONTEXT_BYTES,
    );
    expect(
      cliAdapterContextSchema.safeParse({ contextPack, renderedContext: overInBytes }).success,
    ).toBe(false);

    const underInBytes = "あ".repeat(1_000);
    expect(
      cliAdapterContextSchema.parse({ contextPack, renderedContext: underInBytes }),
    ).toMatchObject({ renderedContext: underInBytes });
  });

  it("still rejects an empty rendered context", () => {
    expect(cliAdapterContextSchema.safeParse({ contextPack, renderedContext: "" }).success).toBe(
      false,
    );
  });
});
