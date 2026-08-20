import { MESSAGE_RETRACT_WINDOW_MS, type Message } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import { canRetractOwnMessage, retractWindowRemainingMs } from "./message-retract";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-08-20T12:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

const message: Message = {
  id: "10000000-0000-4000-8000-000000000003",
  conversationId: "10000000-0000-4000-8000-000000000004",
  conversationSequence: "1",
  version: 1,
  clientMessageId: "10000000-0000-4000-8000-000000000005",
  authorId: USER_ID,
  threadRootId: null,
  body: "still stored",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

describe("canRetractOwnMessage", () => {
  it("allows the author only inside the five-minute window", () => {
    expect(canRetractOwnMessage(message, USER_ID, CREATED_AT_MS)).toBe(true);
    expect(
      canRetractOwnMessage(message, USER_ID, CREATED_AT_MS + MESSAGE_RETRACT_WINDOW_MS),
    ).toBe(true);
    expect(
      canRetractOwnMessage(message, USER_ID, CREATED_AT_MS + MESSAGE_RETRACT_WINDOW_MS + 1),
    ).toBe(false);
  });

  it("never offers retract on another author's message or a tombstone", () => {
    expect(canRetractOwnMessage(message, OTHER_ID, CREATED_AT_MS)).toBe(false);
    expect(
      canRetractOwnMessage({ ...message, deletedAt: CREATED_AT }, USER_ID, CREATED_AT_MS),
    ).toBe(false);
  });

  it("does not treat a missing createdAt as still retractable", () => {
    expect(retractWindowRemainingMs("not-a-date", CREATED_AT_MS)).toBe(0);
    expect(canRetractOwnMessage({ ...message, createdAt: "not-a-date" }, USER_ID, CREATED_AT_MS)).toBe(
      false,
    );
  });
});
