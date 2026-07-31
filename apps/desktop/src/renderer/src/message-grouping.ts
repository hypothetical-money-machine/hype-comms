import { shouldShowDateSeparator } from "./message-date-separator";

export interface MessageGroupCandidate {
  readonly authorId: string | null;
  readonly createdAt: string;
  readonly conversationSequence: string | null;
}

function hasAdjacentConversationSequence(
  current: MessageGroupCandidate,
  previous: MessageGroupCandidate,
): boolean {
  if (current.conversationSequence === null) return true;
  if (previous.conversationSequence === null) return false;
  return BigInt(current.conversationSequence) === BigInt(previous.conversationSequence) + 1n;
}

export function isMessageContinuation(
  current: MessageGroupCandidate,
  previous: MessageGroupCandidate | null,
  timeZone?: string,
): boolean {
  return (
    current.authorId !== null &&
    previous !== null &&
    current.authorId === previous.authorId &&
    hasAdjacentConversationSequence(current, previous) &&
    !shouldShowDateSeparator(current.createdAt, previous.createdAt, timeZone)
  );
}
