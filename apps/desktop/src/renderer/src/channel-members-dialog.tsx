import type {
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  User,
} from "@hmm-chat/contracts";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

interface ChannelMembersDialogProps {
  readonly channelName: string;
  readonly conversationId: string;
  readonly workspaceMembers: readonly User[];
  readonly onClose: () => void;
  readonly load: (conversationId: string) => Promise<ChannelMembersResponse>;
  readonly upsert: (
    conversationId: string,
    userId: string,
    role: "owner" | "member",
  ) => Promise<ChannelMembershipMutationResponse>;
  readonly remove: (
    conversationId: string,
    userId: string,
  ) => Promise<ChannelMembershipMutationResponse>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not update channel members";
}

export function ChannelMembersDialog({
  channelName,
  conversationId,
  workspaceMembers,
  onClose,
  load,
  upsert,
  remove,
}: ChannelMembersDialogProps) {
  const [details, setDetails] = useState<ChannelMembersResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void load(conversationId)
      .then((response) => {
        if (active) setDetails(response);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [conversationId, load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && busyUserId === null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busyUserId, onClose]);

  const availableMembers = useMemo(() => {
    const current = new Set(details?.members.map((member) => member.user.id) ?? []);
    return workspaceMembers.filter((member) => !current.has(member.id));
  }, [details, workspaceMembers]);
  const effectiveSelectedUserId = availableMembers.some((member) => member.id === selectedUserId)
    ? selectedUserId
    : (availableMembers[0]?.id ?? "");

  const mutate = async (
    userId: string,
    operation: () => Promise<ChannelMembershipMutationResponse>,
  ): Promise<void> => {
    setBusyUserId(userId);
    setError("");
    try {
      setDetails((await operation()).channelMembers);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusyUserId(null);
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={busyUserId === null ? onClose : undefined}>
      <section
        className="channel-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-members-title"
        aria-busy={busyUserId !== null}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Channel access</p>
            <h2 id="channel-members-title">#{channelName}</h2>
          </div>
          <button
            type="button"
            aria-label="Close members"
            disabled={busyUserId !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {details === null && error === "" && <p>Loading members…</p>}
        {details?.access === "workspace" && (
          <div className="channel-access-note">
            <strong>Open to everyone</strong>
            <p>Every active workspace member can read and send messages in this channel.</p>
          </div>
        )}
        {details?.access === "members" && details.canManage && (
          <div className="channel-member-add">
            <label htmlFor="channel-member-select">Add a workspace member</label>
            <div>
              <select
                id="channel-member-select"
                value={effectiveSelectedUserId}
                disabled={busyUserId !== null || availableMembers.length === 0}
                onChange={(event) => setSelectedUserId(event.target.value)}
              >
                {availableMembers.length === 0 ? (
                  <option value="">Everyone available is already here</option>
                ) : (
                  availableMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                disabled={effectiveSelectedUserId === "" || busyUserId !== null}
                onClick={() =>
                  void mutate(effectiveSelectedUserId, () =>
                    upsert(conversationId, effectiveSelectedUserId, "member"),
                  )
                }
              >
                Add
              </button>
            </div>
          </div>
        )}

        {details !== null && (
          <ul className="channel-member-list">
            {details.members.map((member) => (
              <li key={member.user.id}>
                <div>
                  <strong>{member.user.displayName}</strong>
                  <span>@{member.user.username}</span>
                </div>
                {details.access === "members" && (
                  <span className={`channel-role ${member.role}`}>{member.role}</span>
                )}
                {details.canManage && details.access === "members" && (
                  <div className="channel-member-actions">
                    <button
                      type="button"
                      disabled={busyUserId !== null}
                      onClick={() =>
                        void mutate(member.user.id, () =>
                          upsert(
                            conversationId,
                            member.user.id,
                            member.role === "owner" ? "member" : "owner",
                          ),
                        )
                      }
                    >
                      {member.role === "owner" ? "Make member" : "Make owner"}
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      disabled={busyUserId !== null}
                      onClick={() =>
                        void mutate(member.user.id, () => remove(conversationId, member.user.id))
                      }
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {error !== "" && (
          <p className="channel-members-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busyUserId !== null} onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
