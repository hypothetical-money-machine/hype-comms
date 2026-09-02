import { isSystemChannelSlug, type Conversation } from "@hype-comms/contracts";

/** Shown as the author of every bulletin the server publishes. */
export const BUILT_IN_AUTHOR_NAME = "Hype Comms";

/**
 * Whether a conversation is a server-owned built-in channel.
 *
 * The explicit marker is authoritative; the reserved slug namespace is checked as well so a
 * cached conversation written before the marker existed is still recognized.
 */
export function isBuiltInConversation(conversation: Conversation): boolean {
  return conversation.isBuiltIn === true || isSystemChannelSlug(conversation.slug);
}
