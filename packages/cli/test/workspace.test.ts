import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
} from "@hype-comms/contracts";

import { executeCli } from "../src/cli.js";
import {
  channelSummary,
  CONVERSATION_ID,
  TIMESTAMP,
  USER_ID,
  WORKSPACE_ID,
  user,
} from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hype-comms-cli-workspace-"));
}

function authenticatedRuntime(fetch: typeof globalThis.fetch, homeDirectory: string) {
  return testRuntime({
    homeDirectory,
    env: {
      HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
      HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
    },
    fetch,
  });
}

describe("workspace conversation commands", () => {
  it("advertises group support on one-shot sync", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/sync");
      expect(url.searchParams.get("after")).toBe("0");
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
        `${GROUP_DIRECT_MESSAGES_CAPABILITY},${AGENT_EFFECTIVE_SCOPES_CAPABILITY}`,
      );
      return jsonResponse({ events: [], nextCursor: "0", highWaterCursor: "0", hasMore: false });
    });
    const runtime = authenticatedRuntime(fetch, await home());

    expect(await executeCli(["sync", "--after", "0", "--json"], runtime)).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toMatchObject({ events: [], nextCursor: "0" });
  });

  it("lists public channels an agent can discover", async () => {
    const response = {
      channels: [{ conversation: channelSummary().conversation, joined: false }],
      nextCursor: null,
      hasMore: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/channels");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(init?.method).toBe("GET");
      return jsonResponse(response);
    });
    const runtime = authenticatedRuntime(fetch, await home());

    expect(await executeCli(["channels", "list", "--json"], runtime)).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toEqual(response);
    expect(runtime.stderrText()).toBe("");
  });

  it("joins an unseated public channel by slug", async () => {
    const joinedSummary = { ...channelSummary(), membershipRole: "member" as const };
    const result = { conversation: joinedSummary, syncCursor: "7" };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/channels") {
        expect(url.searchParams.get("limit")).toBe("100");
        return jsonResponse({
          channels: [{ conversation: channelSummary().conversation, joined: false }],
          nextCursor: null,
          hasMore: false,
        });
      }
      expect(url.pathname).toBe(`/v1/channels/${CONVERSATION_ID}/membership`);
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBeUndefined();
      return jsonResponse(result);
    });
    const runtime = authenticatedRuntime(fetch, await home());

    expect(await executeCli(["channels", "join", "#launch-planning", "--json"], runtime)).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toEqual(result);
    expect(runtime.stderrText()).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("creates a group direct conversation with people and conversational agents", async () => {
    const humanId = "66666666-6666-4666-8666-666666666666";
    const creatorId = "77777777-7777-4777-8777-777777777777";
    const groupId = "88888888-8888-4888-8888-888888888888";
    const members = [
      user(),
      { ...user({ id: humanId, username: "morgan", displayName: "Morgan" }), kind: "human" },
    ];
    const result = {
      conversation: {
        conversation: {
          id: groupId,
          workspaceId: WORKSPACE_ID,
          kind: "group_direct_message",
          name: null,
          slug: null,
          topic: null,
          access: null,
          channelMode: null,
          isArchived: false,
          createdBy: creatorId,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        participantIds: [creatorId, USER_ID, humanId],
        membershipRole: "owner",
        lastMessage: null,
        unreadCount: 0,
        mentionCount: 0,
        readCursor: null,
      },
      syncCursor: "8",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/members") return jsonResponse({ members });
      expect(url.pathname).toBe("/v1/group-direct-conversations");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("group-test-1");
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(
        `${GROUP_DIRECT_MESSAGES_CAPABILITY},${AGENT_EFFECTIVE_SCOPES_CAPABILITY}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({ memberIds: [USER_ID, humanId] });
      return jsonResponse(result, { status: 201 });
    });
    const runtime = authenticatedRuntime(fetch, await home());

    expect(
      await executeCli(
        [
          "dms",
          "create-group",
          "@hermes",
          "@morgan",
          "--idempotency-key",
          "group-test-1",
          "--json",
        ],
        runtime,
      ),
    ).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toEqual(result);
    expect(runtime.stderrText()).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate group participants before creating a conversation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/members");
      return jsonResponse({ members: [user()] });
    });
    const runtime = authenticatedRuntime(fetch, await home());

    expect(
      await executeCli(
        ["dms", "create-group", "@hermes", USER_ID, "--idempotency-key", "group-test-2", "--json"],
        runtime,
      ),
    ).toBe(2);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "DUPLICATE_MEMBER", retryable: false },
    });
    expect(runtime.stdoutText()).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "fewer than two", members: ["@hermes"] },
    {
      label: "more than twenty-four",
      members: Array.from({ length: 25 }, (_, index) => `@member-${index + 1}`),
    },
  ])("rejects $label group participants before any server request", async ({ members }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = authenticatedRuntime(fetch, await home());

    expect(await executeCli(["dms", "create-group", ...members, "--json"], runtime)).toBe(2);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "INVALID_GROUP_SIZE", retryable: false },
    });
    expect(runtime.stdoutText()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
