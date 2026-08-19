import type {
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  User,
} from "@hype-comms/contracts";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

interface PeopleDirectorySharedProps {
  readonly currentUserId: string;
  readonly workspaceMembers: readonly User[];
  readonly onClose: () => void;
  readonly onMessage: (memberId: string) => void;
}

interface ChannelPeopleDialogProps extends PeopleDirectorySharedProps {
  readonly source: "channel";
  readonly channelName: string;
  readonly conversationId: string;
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

interface WorkspacePeopleDialogProps extends PeopleDirectorySharedProps {
  readonly source: "workspace";
}

export type ChannelMembersDialogProps = ChannelPeopleDialogProps | WorkspacePeopleDialogProps;

interface DirectoryEntry {
  readonly user: User;
  readonly role: "owner" | "member" | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not update channel members";
}

function kindLabel(kind: User["kind"]): string | null {
  if (kind === "agent") return "Agent";
  if (kind === "bot") return "Bot";
  return null;
}

function canMessage(user: User): boolean {
  return user.kind !== "bot";
}

export function ChannelMembersDialog(props: ChannelMembersDialogProps) {
  const { currentUserId, workspaceMembers, onClose, onMessage, source } = props;
  const [details, setDetails] = useState<ChannelMembersResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isChannel = source === "channel";
  const channelName = source === "channel" ? props.channelName : null;
  const conversationId = source === "channel" ? props.conversationId : null;
  const load = source === "channel" ? props.load : null;
  const upsert = source === "channel" ? props.upsert : null;
  const remove = source === "channel" ? props.remove : null;

  useEffect(() => {
    if (load === null || conversationId === null) return;
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

  const directory: readonly DirectoryEntry[] | null = isChannel
    ? details === null
      ? null
      : details.members.map((member) => ({ user: member.user, role: member.role }))
    : workspaceMembers.map((user) => ({ user, role: null }));
  const showChannelRole = details?.access === "members";
  const canManageChannel = details?.canManage === true && details.access === "members";
  const loadingChannel = isChannel && details === null && error === "";

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

  const titleId = isChannel ? "channel-members-title" : "workspace-people-title";

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={busyUserId === null ? onClose : undefined}>
      <section
        className="channel-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busyUserId !== null}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{isChannel ? "Channel access" : "Workspace"}</p>
            <h2 id={titleId}>{channelName === null ? "People" : `#${channelName}`}</h2>
          </div>
          <button
            type="button"
            aria-label="Close people"
            disabled={busyUserId !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {loadingChannel && <p>Loading members…</p>}
        {details?.access === "workspace" && (
          <div className="channel-access-note">
            <strong>Open to everyone</strong>
            <p>Every active workspace member can read and send messages in this channel.</p>
          </div>
        )}
        {canManageChannel && conversationId !== null && upsert !== null && (
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

        {directory !== null && (
          <ul className="channel-member-list">
            {directory.map((entry) => {
              const kind = kindLabel(entry.user.kind);
              return (
                <li key={entry.user.id}>
                  <span className="avatar" aria-hidden="true">
                    {entry.user.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="channel-member-identity">
                    <strong>
                      {entry.user.displayName}
                      {entry.user.id === currentUserId ? " (you)" : ""}
                    </strong>
                    <span>@{entry.user.username}</span>
                  </div>
                  {kind !== null && <span className="member-kind">{kind}</span>}
                  {showChannelRole && entry.role !== null && (
                    <span className={`channel-role ${entry.role}`}>{entry.role}</span>
                  )}
                  <div className="channel-member-actions">
                    {canMessage(entry.user) && (
                      <button
                        type="button"
                        disabled={busyUserId !== null}
                        onClick={() => onMessage(entry.user.id)}
                      >
                        Message
                      </button>
                    )}
                    {canManageChannel &&
                      conversationId !== null &&
                      upsert !== null &&
                      remove !== null &&
                      entry.role !== null && (
                        <>
                          <button
                            type="button"
                            disabled={busyUserId !== null}
                            onClick={() =>
                              void mutate(entry.user.id, () =>
                                upsert(
                                  conversationId,
                                  entry.user.id,
                                  entry.role === "owner" ? "member" : "owner",
                                ),
                              )
                            }
                          >
                            {entry.role === "owner" ? "Make member" : "Make owner"}
                          </button>
                          <button
                            className="danger-button"
                            type="button"
                            disabled={busyUserId !== null}
                            onClick={() =>
                              void mutate(entry.user.id, () =>
                                remove(conversationId, entry.user.id),
                              )
                            }
                          >
                            Remove
                          </button>
                        </>
                      )}
                  </div>
                </li>
              );
            })}
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
