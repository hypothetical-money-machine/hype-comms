import type { ConversationKind } from "@hmm-chat/contracts";

export function ConversationEmptyState({
  conversationName,
  kind,
  personal,
  archived,
}: {
  readonly conversationName: string | null;
  readonly kind: ConversationKind | null;
  readonly personal: boolean;
  readonly archived: boolean;
}) {
  let title = "Choose a conversation";
  let description = "Select a channel or direct message from the sidebar.";

  if (conversationName !== null && archived) {
    title = `No messages in ${conversationName}`;
    description = "This archived channel is read-only.";
  } else if (conversationName !== null && kind === "channel") {
    title = `Welcome to ${conversationName}`;
    description = `This is the beginning of ${conversationName}.`;
  } else if (conversationName !== null && personal) {
    title = "Your personal space";
    description = "Keep notes, links, and reminders here for yourself.";
  } else if (conversationName !== null) {
    title = `Start a conversation with ${conversationName}`;
    description = "Send a message to get the conversation going.";
  }

  return (
    <div className="empty-state conversation-empty-state">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

export function ArchivedConversationNotice({ thread = false }: { readonly thread?: boolean }) {
  return (
    <div
      className={`archived-conversation-notice${thread ? " thread-archived-notice" : ""}`}
      role="note"
      aria-label={thread ? "Archived thread" : "Archived channel"}
    >
      <strong>{thread ? "This thread is read-only" : "This channel is archived"}</strong>
      <span>
        {thread
          ? "Replies are unavailable in archived channels."
          : "Messages are available to read, but new messages cannot be sent."}
      </span>
    </div>
  );
}
