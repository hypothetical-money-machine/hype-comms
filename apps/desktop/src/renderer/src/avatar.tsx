import type { User } from "@hype-comms/contracts";

export function Avatar({ user }: { user: User | undefined }) {
  return (
    <span className="avatar" aria-hidden="true">
      {(user?.displayName ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}
