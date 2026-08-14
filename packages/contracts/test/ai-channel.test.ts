import { describe, expect, it } from "vitest";

import {
  aiChannelPermissionResponseSchema,
  aiChannelPromptRequestSchema,
  aiChannelStateSchema,
} from "../src/ai-channel.js";

const NOW = "2026-08-11T12:00:00.000Z";

describe("AI Channel contracts", () => {
  it("accepts a strict curated renderer state", () => {
    expect(
      aiChannelStateSchema.parse({
        version: 1,
        generation: 7,
        status: "running",
        workspaceName: "hype-comms",
        entries: [
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            body: "I am checking the tests.",
            createdAt: NOW,
          },
          {
            type: "tool",
            id: "tool-1",
            title: "Run the focused test suite",
            kind: "execute",
            status: "in_progress",
            locations: ["apps/desktop"],
            createdAt: NOW,
          },
        ],
        plan: [{ content: "Run tests", priority: "high", status: "in_progress" }],
        permissionRequest: {
          id: "permission-1",
          toolCallId: "tool-1",
          title: "Run the focused test suite",
          kind: "execute",
          options: [
            { id: "allow", name: "Allow once", kind: "allow_once" },
            { id: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        error: null,
      }),
    ).toBeDefined();
  });

  it("rejects raw ACP fields and unbounded prompt input", () => {
    expect(() =>
      aiChannelStateSchema.parse({
        version: 1,
        generation: 7,
        status: "ready",
        workspaceName: "hype-comms",
        entries: [],
        plan: [],
        permissionRequest: null,
        error: null,
        rawInput: { command: "cat ~/.ssh/id_ed25519" },
      }),
    ).toThrow();
    expect(() =>
      aiChannelPromptRequestSchema.parse({ generation: 7, prompt: "x".repeat(64_001) }),
    ).toThrow();
  });

  it("requires permission responses to target one exact request and supplied option", () => {
    expect(
      aiChannelPermissionResponseSchema.parse({
        generation: 7,
        requestId: "permission-1",
        optionId: "allow",
      }),
    ).toEqual({ generation: 7, requestId: "permission-1", optionId: "allow" });
    expect(() =>
      aiChannelPermissionResponseSchema.parse({
        generation: 7,
        requestId: "permission-1",
        allow: true,
      }),
    ).toThrow();
    expect(() =>
      aiChannelPermissionResponseSchema.parse({
        generation: 7,
        requestId: " permission-1",
        optionId: "allow ",
      }),
    ).toThrow();
  });
});
