import { describe, expect, it } from "vitest";

import type { Conversation } from "@hype-comms/contracts";

import { isBuiltInConversation } from "./built-in-channels";

const NOW = "2026-07-24T12:00:00.000Z";
const base: Conversation = {
  id: "10000000-0000-4000-8000-000000000031",
  workspaceId: "10000000-0000-4000-8000-000000000030",
  kind: "channel",
  name: "Release notes",
  slug: "hype/release-notes",
  topic: null,
  access: "workspace",
  channelMode: "announcement",
  isBuiltIn: true,
  isArchived: false,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("isBuiltInConversation", () => {
  it("recognizes a built-in channel from its marker", () => {
    expect(isBuiltInConversation(base)).toBe(true);
  });

  it("recognizes the reserved namespace when a cached record predates the marker", () => {
    const withoutMarker: Record<string, unknown> = { ...base };
    delete withoutMarker.isBuiltIn;
    expect(isBuiltInConversation(withoutMarker as Conversation)).toBe(true);
  });

  it("treats member channels and direct conversations as ordinary", () => {
    expect(
      isBuiltInConversation({
        ...base,
        name: "Release notes",
        slug: "release-notes",
        channelMode: "chat",
        isBuiltIn: undefined,
      }),
    ).toBe(false);
    expect(
      isBuiltInConversation({
        ...base,
        kind: "direct_message",
        name: null,
        slug: null,
        access: null,
        channelMode: null,
        isBuiltIn: undefined,
      }),
    ).toBe(false);
  });
});
