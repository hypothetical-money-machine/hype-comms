import type { User } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  filterMentionMembers,
  insertMention,
  mentionQueryAt,
  mentionedMemberIds,
  segmentMentions,
} from "./mentions";

const NOW = "2026-08-04T12:00:00.000Z";

function member(id: string, username: string, displayName: string): User {
  return {
    id,
    kind: "human",
    username,
    displayName,
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const morgan = member("10000000-0000-4000-8000-000000000001", "morgan", "Morgan");
const alex = member("10000000-0000-4000-8000-000000000002", "alex", "Alex Rivera");
const morganSmith = member("10000000-0000-4000-8000-000000000003", "morgan-smith", "Morgan Smith");
const members = [morgan, alex, morganSmith];

describe("mentionQueryAt", () => {
  it("opens a query after a bare @ and keeps filtering as the user types", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("hi @al", 6)).toEqual({ start: 3, query: "al" });
    expect(mentionQueryAt("hi @al", 4)).toEqual({ start: 3, query: "" });
  });

  it("does not open inside an email or other glued word", () => {
    expect(mentionQueryAt("hello@", 6)).toBeNull();
    expect(mentionQueryAt("hello@alex", 10)).toBeNull();
  });

  it("closes once the caret leaves the query", () => {
    expect(mentionQueryAt("hi @al there", 12)).toBeNull();
    expect(mentionQueryAt("hi @al ", 7)).toBeNull();
  });
});

describe("filterMentionMembers", () => {
  it("matches username or display name without changing directory order", () => {
    expect(filterMentionMembers(members, "")).toEqual(members);
    expect(filterMentionMembers(members, "AL")).toEqual([alex]);
    expect(filterMentionMembers(members, "rivera")).toEqual([alex]);
    expect(filterMentionMembers(members, "morgan")).toEqual([morgan, morganSmith]);
    expect(filterMentionMembers(members, "zzz")).toEqual([]);
  });
});

describe("insertMention", () => {
  it("replaces the active query with @username and a trailing space", () => {
    expect(insertMention("hi @al", { start: 3, query: "al" }, "alex")).toEqual({
      text: "hi @alex ",
      cursor: 9,
    });
  });

  it("does not add a second space when the following text already has one", () => {
    expect(insertMention("hi @al there", { start: 3, query: "al" }, "alex")).toEqual({
      text: "hi @alex there",
      cursor: 8,
    });
  });
});

describe("segmentMentions", () => {
  it("turns known @usernames into mention segments and keeps surrounding text", () => {
    expect(segmentMentions("see @alex later", members)).toEqual([
      { kind: "text", text: "see " },
      { kind: "mention", text: "@alex", userId: alex.id, username: "alex" },
      { kind: "text", text: " later" },
    ]);
  });

  it("keeps unknown @tokens as ordinary text", () => {
    expect(segmentMentions("ping @nobody", members)).toEqual([
      { kind: "text", text: "ping @nobody" },
    ]);
  });

  it("prefers the longest matching username so a prefix does not become a chip", () => {
    expect(segmentMentions("ask @morgan-smith", members)).toEqual([
      { kind: "text", text: "ask " },
      {
        kind: "mention",
        text: "@morgan-smith",
        userId: morganSmith.id,
        username: "morgan-smith",
      },
    ]);
  });

  it("resolves display casing while keeping the typed token", () => {
    expect(segmentMentions("@Alex!", members)).toEqual([
      { kind: "mention", text: "@Alex", userId: alex.id, username: "alex" },
      { kind: "text", text: "!" },
    ]);
  });
});

describe("mentionedMemberIds", () => {
  it("keeps the participant-scoped verified mention scan", () => {
    expect(mentionedMemberIds("hi @alex and @morgan", members, [alex.id])).toEqual([alex.id]);
    expect(mentionedMemberIds("hi @nobody", members, [alex.id, morgan.id])).toEqual([]);
  });
});
