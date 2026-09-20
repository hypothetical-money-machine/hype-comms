import { messageDayKey, shouldShowDateSeparator } from "./message-date-separator";

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

function canContinue(
  current: MessageGroupCandidate,
  previous: MessageGroupCandidate | null,
): previous is MessageGroupCandidate {
  return (
    current.authorId !== null &&
    previous !== null &&
    current.authorId === previous.authorId &&
    hasAdjacentConversationSequence(current, previous)
  );
}

function isContinuation(
  current: MessageGroupCandidate,
  previous: MessageGroupCandidate | null,
  showDateSeparator: boolean,
): boolean {
  return !showDateSeparator && canContinue(current, previous);
}

export function isMessageContinuation(
  current: MessageGroupCandidate,
  previous: MessageGroupCandidate | null,
  timeZone?: string,
): boolean {
  if (!canContinue(current, previous)) return false;
  return !shouldShowDateSeparator(current.createdAt, previous.createdAt, timeZone);
}

export interface MessageGroupFlags {
  readonly showDateSeparator: boolean;
  readonly continuation: boolean;
}

/**
 * Derive separator and continuation flags for a whole timeline in one pass. Calling
 * `shouldShowDateSeparator` and `isMessageContinuation` per row re-derives each message's
 * calendar day about four times per render, which dominates long timelines.
 */
export function messageGroupFlags(
  messages: readonly MessageGroupCandidate[],
  groupConsecutive: boolean,
  timeZone?: string,
): MessageGroupFlags[] {
  const flags: MessageGroupFlags[] = [];
  let previous: MessageGroupCandidate | null = null;
  let previousDayKey: string | null = null;
  for (const message of messages) {
    const dayKey = messageDayKey(message.createdAt, timeZone);
    const showDateSeparator = previousDayKey === null || dayKey !== previousDayKey;
    flags.push({
      showDateSeparator,
      continuation: groupConsecutive && isContinuation(message, previous, showDateSeparator),
    });
    previous = message;
    previousDayKey = dayKey;
  }
  return flags;
}
