import { isSystemChannelSlug, SYSTEM_USER_ID, type Conversation } from "@hype-comms/contracts";

/** Shown as the author of every bulletin the server publishes. */
export const BUILT_IN_AUTHOR_NAME = "Hype Comms";

/**
 * The publisher's fixed user id. Attribution matches on this id, not on the conversation: a member
 * who replied in a built-in channel and later left the workspace must still render as a former
 * member, never as the app.
 */
export const BUILT_IN_AUTHOR_ID = SYSTEM_USER_ID;

/**
 * Whether a conversation is a server-owned built-in channel.
 *
 * The explicit marker is authoritative; the reserved slug namespace is checked as well so a
 * cached conversation written before the marker existed is still recognized.
 */
export function isBuiltInConversation(conversation: Conversation): boolean {
  return conversation.isBuiltIn === true || isSystemChannelSlug(conversation.slug);
}
