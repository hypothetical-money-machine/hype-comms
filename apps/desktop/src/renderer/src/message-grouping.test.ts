import { describe, expect, it } from "vitest";

import { isMessageContinuation, type MessageGroupCandidate } from "./message-grouping";

const MORGAN_ID = "10000000-0000-4000-8000-000000000001";
const DAN_ID = "10000000-0000-4000-8000-000000000002";

function candidate(
  authorId: string | null,
  createdAt: string,
  conversationSequence: string | null,
): MessageGroupCandidate {
  return { authorId, createdAt, conversationSequence };
}

describe("message grouping", () => {
  it("continues sequence-adjacent messages from the same author", () => {
    const previous = candidate(MORGAN_ID, "2026-07-27T19:18:00.000Z", "41");
    const current = candidate(MORGAN_ID, "2026-07-27T19:19:00.000Z", "42");

    expect(isMessageContinuation(current, previous, "UTC")).toBe(true);
  });

  it("starts a new group across a gap in loaded conversation history", () => {
    const previous = candidate(MORGAN_ID, "2026-07-27T19:18:00.000Z", "41");
    const current = candidate(MORGAN_ID, "2026-07-27T19:19:00.000Z", "51");

    expect(isMessageContinuation(current, previous, "UTC")).toBe(false);
  });

  it("continues into a pending message that has no server sequence yet", () => {
    const previous = candidate(MORGAN_ID, "2026-07-27T19:18:00.000Z", "41");
    const current = candidate(MORGAN_ID, "2026-07-27T19:19:00.000Z", null);

    expect(isMessageContinuation(current, previous, "UTC")).toBe(true);
  });

  it("starts a new group when the author changes", () => {
    const previous = candidate(DAN_ID, "2026-07-27T19:18:00.000Z", "41");
    const current = candidate(MORGAN_ID, "2026-07-27T19:19:00.000Z", "42");

    expect(isMessageContinuation(current, previous, "UTC")).toBe(false);
  });

  it("starts a new group at a local calendar-day boundary", () => {
    const previous = candidate(MORGAN_ID, "2026-07-28T06:59:00.000Z", "41");
    const current = candidate(MORGAN_ID, "2026-07-28T07:01:00.000Z", "42");

    expect(isMessageContinuation(current, previous, "America/Los_Angeles")).toBe(false);
  });

  it("does not group messages whose former author is unknown", () => {
    const previous = candidate(null, "2026-07-27T19:18:00.000Z", "41");
    const current = candidate(null, "2026-07-27T19:19:00.000Z", "42");

    expect(isMessageContinuation(current, previous, "UTC")).toBe(false);
  });
});
