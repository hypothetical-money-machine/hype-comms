import type { NotificationActivityView } from "@hype-comms/contracts";

export function createNotificationActivityView(input: {
  readonly pane: "chat" | "tasks";
  readonly conversationId: string | null;
  readonly timelineAtLiveTail: boolean;
  readonly threadRootId: string | null;
  readonly threadAtLiveTail: boolean;
}): NotificationActivityView {
  if (input.conversationId === null) return { pane: "none" };
  if (input.pane === "tasks") {
    return { pane: "tasks", conversationId: input.conversationId };
  }
  return {
    pane: "chat",
    conversationId: input.conversationId,
    timelineAtLiveTail: input.timelineAtLiveTail,
    thread:
      input.threadRootId === null
        ? null
        : { rootId: input.threadRootId, atLiveTail: input.threadAtLiveTail },
  };
}
