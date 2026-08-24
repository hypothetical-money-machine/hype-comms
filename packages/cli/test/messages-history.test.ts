import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CONTEXT_PACK_CAPABILITY,
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  type AgentContextHistoryResponse,
  ATTACHMENTS_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
} from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import { executeCli, HELP } from "../src/cli.js";
import { EXIT_CONTRACT, EXIT_SUCCESS, EXIT_USAGE } from "../src/errors.js";
import { CONVERSATION_ID, MESSAGE_ID } from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hype-comms-cli-history-"));
}

function historyResponse(): object {
  return {
    messages: [],
    threadSummaries: [],
    threadsSupported: false,
    attachments: [],
    nextCursor: null,
  };
}

function contextHistoryResponse(): AgentContextHistoryResponse {
  return {
    contextPack: {
      version: 1,
      conversation: {
        id: CONVERSATION_ID,
        kind: "channel",
        slug: "launch-planning",
        selector: "#launch-planning",
      },
      anchorMessageId: null,
      messages: [],
      threadRoot: null,
      replyTarget: null,
      readThroughMessageId: null,
      truncatedBefore: false,
      nextCursor: null,
    },
  };
}

describe("messages history", () => {
  it("preserves the legacy request and response contract without context mode", async () => {
    const response = historyResponse();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `https://chat.example.test/v1/conversations/${CONVERSATION_ID}/messages?before=older_page&limit=100`,
      );
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
        `${ATTACHMENTS_CAPABILITY},${GROUP_DIRECT_MESSAGES_CAPABILITY},${AGENT_EFFECTIVE_SCOPES_CAPABILITY}`,
      );
      return jsonResponse(response);
    });
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch,
    });

    expect(
      await executeCli(
        [
          "messages",
          "history",
          CONVERSATION_ID,
          "--before",
          "older_page",
          "--limit",
          "100",
          "--json",
        ],
        runtime,
      ),
    ).toBe(EXIT_SUCCESS);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(runtime.stdoutText())).toEqual(response);
    expect(runtime.stderrText()).toBe("");
  });

  it("negotiates and anchors context-pack history", async () => {
    const response = contextHistoryResponse();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/v1/conversations/${CONVERSATION_ID}/messages`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        contextPack: "true",
        throughMessageId: MESSAGE_ID,
        limit: "8",
      });
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
        `${AGENT_CONTEXT_PACK_CAPABILITY},${GROUP_DIRECT_MESSAGES_CAPABILITY},${AGENT_EFFECTIVE_SCOPES_CAPABILITY}`,
      );
      return jsonResponse(response);
    });
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch,
    });

    expect(
      await executeCli(
        [
          "messages",
          "history",
          CONVERSATION_ID,
          "--context-pack",
          "--through-message-id",
          MESSAGE_ID,
          "--json",
        ],
        runtime,
      ),
    ).toBe(EXIT_SUCCESS);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(runtime.stdoutText())).toEqual(response);
    expect(runtime.stderrText()).toBe("");
  });

  it("sends a context cursor and explicit bounded limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(Object.fromEntries(url.searchParams)).toEqual({
        contextPack: "true",
        before: "older_context",
        limit: "20",
      });
      return jsonResponse(contextHistoryResponse());
    });
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch,
    });

    expect(
      await executeCli(
        [
          "messages",
          "history",
          CONVERSATION_ID,
          "--context-pack",
          "--before",
          "older_context",
          "--limit",
          "20",
          "--json",
        ],
        runtime,
      ),
    ).toBe(EXIT_SUCCESS);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a legacy history response in context mode", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(historyResponse()));
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch,
    });

    expect(
      await executeCli(
        ["messages", "history", CONVERSATION_ID, "--context-pack", "--json"],
        runtime,
      ),
    ).toBe(EXIT_CONTRACT);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "INVALID_SERVER_CONTRACT" },
    });
  });

  it.each([
    {
      label: "uses a through anchor without context mode",
      args: ["--through-message-id", MESSAGE_ID],
    },
    {
      label: "combines a through anchor and a before cursor",
      args: ["--context-pack", "--through-message-id", MESSAGE_ID, "--before", "older"],
    },
    {
      label: "uses a malformed through anchor",
      args: ["--context-pack", "--through-message-id", "not-a-uuid"],
    },
    {
      label: "exceeds the context limit",
      args: ["--context-pack", "--limit", "21"],
    },
    {
      label: "uses a zero context limit",
      args: ["--context-pack", "--limit", "0"],
    },
    {
      label: "exceeds the legacy limit",
      args: ["--limit", "101"],
    },
  ])("rejects history that $label", async ({ args }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch,
    });

    expect(
      await executeCli(["messages", "history", CONVERSATION_ID, ...args, "--json"], runtime),
    ).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stdoutText()).toBe("");
  });

  it("documents context-pack history in help", () => {
    expect(HELP).toContain(
      "messages history CONVERSATION --context-pack [--through-message-id UUID]",
    );
  });
});
