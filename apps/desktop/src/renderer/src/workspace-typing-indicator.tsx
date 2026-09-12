import { useCallback } from "react";
import type { User } from "@hype-comms/contracts";
import { TypingIndicator, typingIndicatorText } from "./activity-indicators";
import type { WorkspaceRuntimeState } from "./workspace-runtime";
import { useWorkspaceSelection, type WorkspaceStore } from "./workspace-selection";

export function WorkspaceTypingIndicator({
  runtime,
  conversationId,
  members,
  currentUserId,
}: {
  readonly runtime: WorkspaceStore;
  readonly conversationId: string | null;
  readonly members: readonly User[];
  readonly currentUserId: string;
}) {
  const select = useCallback(
    (state: WorkspaceRuntimeState) =>
      typingIndicatorText(
        conversationId === null ? [] : (state.typingByConversation[conversationId] ?? []),
        members,
        currentUserId,
      ),
    [conversationId, members, currentUserId],
  );
  return <TypingIndicator text={useWorkspaceSelection(runtime, select)} />;
}
