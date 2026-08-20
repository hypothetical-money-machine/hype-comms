import { MESSAGE_RETRACT_WINDOW_MS, type Message } from "@hype-comms/contracts";

export function retractWindowRemainingMs(createdAt: string, nowMs = Date.now()): number {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return 0;
  return MESSAGE_RETRACT_WINDOW_MS - (nowMs - createdAtMs);
}

/** UI-only gate. The server clock is authoritative at the 403 / 409 boundary. */
export function canRetractOwnMessage(
  message: Message,
  currentUserId: string,
  nowMs = Date.now(),
): boolean {
  if (message.deletedAt !== null || message.authorId !== currentUserId) return false;
  const createdAtMs = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs <= MESSAGE_RETRACT_WINDOW_MS;
}
