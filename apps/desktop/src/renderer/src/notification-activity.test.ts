import { describe, expect, it } from "vitest";

import { createNotificationActivityView } from "./notification-activity";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const THREAD_ROOT_ID = "10000000-0000-4000-8000-000000000002";

describe("createNotificationActivityView", () => {
  it("reports no visible stream without a selected conversation", () => {
    expect(
      createNotificationActivityView({
        pane: "chat",
        conversationId: null,
        timelineAtLiveTail: true,
        threadRootId: null,
        threadAtLiveTail: true,
      }),
    ).toEqual({ pane: "none" });
  });

  it("does not claim a message tail while Tasks is shown", () => {
    expect(
      createNotificationActivityView({
        pane: "tasks",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        threadRootId: THREAD_ROOT_ID,
        threadAtLiveTail: true,
      }),
    ).toEqual({ pane: "tasks", conversationId: CONVERSATION_ID });
  });

  it("reports timeline and thread tails independently", () => {
    expect(
      createNotificationActivityView({
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: false,
        threadRootId: THREAD_ROOT_ID,
        threadAtLiveTail: true,
      }),
    ).toEqual({
      pane: "chat",
      conversationId: CONVERSATION_ID,
      timelineAtLiveTail: false,
      thread: { rootId: THREAD_ROOT_ID, atLiveTail: true },
    });
  });
});
