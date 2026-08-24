import type { PresenceState, User } from "@hype-comms/contracts";

export function PresenceIndicator({ state }: { readonly state: PresenceState }) {
  return (
    <span
      className={`presence-indicator presence-${state}`}
      aria-label={`Presence: ${state}`}
      title={state[0]?.toUpperCase() + state.slice(1)}
    />
  );
}

export function typingIndicatorText(
  userIds: readonly string[],
  members: readonly User[],
  currentUserId: string,
): string {
  const names = [...new Set(userIds)]
    .filter((userId) => userId !== currentUserId)
    .map((userId) => members.find((member) => member.id === userId)?.displayName)
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing…`;
  return `${names[0]}, ${names[1]}, and ${String(names.length - 2)} others are typing…`;
}
