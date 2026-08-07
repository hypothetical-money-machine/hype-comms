import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/client.js";
import {
  listAllConversations,
  resolveConversationSelector,
  resolveMemberSelector,
} from "../src/selectors.js";
import { channelSummary, CONVERSATION_ID, USER_ID, user } from "./fixtures.js";
import { jsonResponse } from "./helpers.js";

function client(fetch: typeof globalThis.fetch): ApiClient {
  return new ApiClient({
    profile: {
      name: "test",
      apiOrigin: "https://chat.example.test",
      credentialFromEnvironment: false,
      configDirectory: "/unused",
    },
    fetch,
    timeoutMs: 1_000,
  });
}

describe("friendly selectors", () => {
  it("resolves member usernames and channel slugs to canonical IDs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/members") return jsonResponse({ members: [user()] });
      if (url.pathname === "/v1/conversations") {
        return jsonResponse({
          conversations: [channelSummary()],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error("Unexpected route");
    });
    const value = client(fetch);
    await expect(resolveMemberSelector(value, "@HERMES")).resolves.toBe(USER_ID);
    await expect(resolveConversationSelector(value, "#launch-planning")).resolves.toBe(
      CONVERSATION_ID,
    );
  });

  it("fails deterministically when pagination does not advance", async () => {
    const value = client(
      vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({
          conversations: [],
          nextCursor: "same-cursor",
          hasMore: true,
        }),
      ),
    );
    await expect(listAllConversations(value)).rejects.toMatchObject({
      code: "PAGINATION_STALLED",
      exitCode: 2,
    });
  });
});
