import type {
  ChannelMode,
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  PresenceState,
  User,
} from "@hype-comms/contracts";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Avatar } from "./avatar";
import { PresenceIndicator } from "./activity-indicators";
import { useOpenChangeNotifier } from "./use-open-change-notifier";

interface PeopleDirectorySharedProps {
  readonly currentUserId: string;
  readonly workspaceMembers: readonly User[];
  readonly presenceByUser?: Readonly<Record<string, PresenceState>>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onMessage: (memberId: string) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

interface ChannelPeopleDialogProps extends PeopleDirectorySharedProps {
  readonly source: "channel";
  readonly channelName: string;
  readonly channelMode?: ChannelMode | null;
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
  readonly pending: boolean;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

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

function memberOptionLabel(member: User): string {
  return member.title !== null && member.title !== undefined
    ? `${member.displayName} · ${member.title}`
    : member.displayName;
}

function matchesQuery(member: User, query: string): boolean {
  return (
    member.displayName.toLowerCase().includes(query) ||
    member.username.toLowerCase().includes(query) ||
    (member.title ?? "").toLowerCase().includes(query)
  );
}

function DirectoryIdentity({
  currentUserId,
  presence,
  user,
}: {
  readonly currentUserId: string;
  readonly presence: PresenceState;
  readonly user: User;
}) {
  return (
    <>
      <span className="member-avatar-presence">
        <Avatar user={user} />
        <PresenceIndicator state={presence} />
      </span>
      <div className="channel-member-identity">
        <strong>
          {user.displayName}
          {user.id === currentUserId ? " (you)" : ""}
        </strong>
        <span>@{user.username}</span>
        {user.title !== null && user.title !== undefined && (
          <span className="channel-member-title">{user.title}</span>
        )}
      </div>
    </>
  );
}

export function ChannelMembersDialog(props: ChannelMembersDialogProps) {
  const {
    currentUserId,
    workspaceMembers,
    presenceByUser = {},
    triggerRef,
    onClose,
    onMessage,
    source,
    onOpenChange,
  } = props;
  const dialogRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [details, setDetails] = useState<ChannelMembersResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingAddIds, setPendingAddIds] = useState<ReadonlySet<string>>(new Set());
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const snapshotSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const pendingAddIdsRef = useRef<ReadonlySet<string>>(new Set());
  const isChannel = source === "channel";
  const conversationId = source === "channel" ? props.conversationId : null;
  const isAnnouncementChannel = source === "channel" && props.channelMode === "announcement";
  const load = source === "channel" ? props.load : null;
  const upsert = source === "channel" ? props.upsert : null;
  const remove = source === "channel" ? props.remove : null;

  useOpenChangeNotifier(true, onOpenChange);

  const nextSnapshotSeq = (): number => {
    snapshotSeqRef.current += 1;
    return snapshotSeqRef.current;
  };

  const setPendingAdds = (ids: ReadonlySet<string>): void => {
    pendingAddIdsRef.current = ids;
    setPendingAddIds(ids);
  };

  const applySnapshot = (seq: number, snapshot: ChannelMembersResponse): void => {
    if (seq <= appliedSeqRef.current) return;
    appliedSeqRef.current = seq;
    const pending = pendingAddIdsRef.current;
    if (pending.size === 0) {
      setDetails(snapshot);
      return;
    }
    const present = new Set(snapshot.members.map((member) => member.user.id));
    const joinedAt = new Date().toISOString();
    const optimistic = workspaceMembers
      .filter((member) => pending.has(member.id) && !present.has(member.id))
      .map((member) => ({ user: member, role: "member" as const, joinedAt }));
    setDetails({ ...snapshot, members: [...snapshot.members, ...optimistic] });
  };

  useEffect(() => {
    if (load === null || conversationId === null) return;
    let active = true;
    const seq = nextSnapshotSeq();
    void load(conversationId)
      .then((response) => {
        if (active) applySnapshot(seq, response);
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
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    if (firstFocusable === null) dialog?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const firstFocusable = focusable[0];
    const lastFocusable = focusable.at(-1);
    if (firstFocusable === undefined || lastFocusable === undefined) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === firstFocusable || activeElement === dialog)) {
      event.preventDefault();
      lastFocusable.focus();
    } else if (!event.shiftKey && activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
    }
  };

  const availableMembers = useMemo(() => {
    const current = new Set(details?.members.map((member) => member.user.id) ?? []);
    return workspaceMembers.filter((member) => !current.has(member.id));
  }, [details, workspaceMembers]);

  const filteredMembers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query === "") return availableMembers;
    return availableMembers.filter((member) => matchesQuery(member, query));
  }, [availableMembers, searchQuery]);

  const checkedAvailableIds = useMemo(
    () => availableMembers.filter((member) => checkedIds.has(member.id)).map((member) => member.id),
    [availableMembers, checkedIds],
  );

  const directory: readonly DirectoryEntry[] | null = isChannel
    ? details === null
      ? null
      : details.members.map((member) => ({
          user: member.user,
          role: member.role,
          pending: pendingAddIds.has(member.user.id),
        }))
    : workspaceMembers.map((user) => ({ user, role: null, pending: false }));
  const showChannelRole = details?.access === "members";
  const canManageChannel = details?.canManage === true && details.access === "members";
  const loadingChannel = isChannel && details === null && error === "";
  const anyBusy = busyUserId !== null || pendingAddIds.size > 0;

  const toggleChecked = (userId: string): void => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const reconcileFromServer = async (): Promise<void> => {
    if (load === null || conversationId === null) return;
    const seq = nextSnapshotSeq();
    try {
      applySnapshot(seq, await load(conversationId));
    } catch {
      // Keep the reconciled local state when the refresh fails.
    }
  };

  const runBatchAdd = async (ids: readonly string[]): Promise<void> => {
    if (upsert === null || conversationId === null) return;
    const results = await Promise.allSettled(
      ids.map(async (userId) => {
        const seq = nextSnapshotSeq();
        const response = await upsert(conversationId, userId, "member");
        applySnapshot(seq, response.channelMembers);
      }),
    );
    const failedIds = ids.filter((_, index) => results.at(index)?.status === "rejected");
    const nextPending = new Set(pendingAddIdsRef.current);
    for (const userId of ids) nextPending.delete(userId);
    setPendingAdds(nextPending);
    if (failedIds.length > 0) {
      const failed = new Set(failedIds);
      setDetails((current) =>
        current === null
          ? current
          : {
              ...current,
              members: current.members.filter((member) => !failed.has(member.user.id)),
            },
      );
      const names = failedIds.map(
        (userId) => workspaceMembers.find((member) => member.id === userId)?.displayName ?? userId,
      );
      const firstRejection = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      setError(`Could not add ${names.join(", ")}: ${errorMessage(firstRejection?.reason)}`);
    }
    await reconcileFromServer();
  };

  const addCheckedMembers = (): void => {
    if (upsert === null || conversationId === null) return;
    const ids = checkedAvailableIds;
    if (ids.length === 0) return;
    setCheckedIds(new Set());
    setError("");
    const nextPending = new Set(pendingAddIdsRef.current);
    for (const userId of ids) nextPending.add(userId);
    setPendingAdds(nextPending);
    const joinedAt = new Date().toISOString();
    setDetails((current) => {
      if (current === null) return current;
      const present = new Set(current.members.map((member) => member.user.id));
      const added = workspaceMembers
        .filter((member) => ids.includes(member.id) && !present.has(member.id))
        .map((member) => ({ user: member, role: "member" as const, joinedAt }));
      return { ...current, members: [...current.members, ...added] };
    });
    searchInputRef.current?.focus();
    void runBatchAdd(ids);
  };

  const mutate = async (
    userId: string,
    operation: () => Promise<ChannelMembershipMutationResponse>,
  ): Promise<void> => {
    setBusyUserId(userId);
    setError("");
    const seq = nextSnapshotSeq();
    try {
      applySnapshot(seq, (await operation()).channelMembers);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusyUserId((current) => (current === userId ? null : current));
    }
    // Snapshot seqs order responses by request start, not server commit, so a concurrent batch
    // add can apply a later snapshot first and cause this response to be discarded as stale.
    // Reconcile against the server so the mutation's effect always becomes visible.
    await reconcileFromServer();
  };

  const titleId = isChannel ? "channel-members-title" : "workspace-people-title";

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="channel-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={anyBusy}
        tabIndex={-1}
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{isChannel ? "Channel access" : "Workspace"}</p>
            <h2 id={titleId}>{source === "channel" ? `#${props.channelName}` : "People"}</h2>
          </div>
          <button
            type="button"
            aria-label={isChannel ? "Close channel access" : "Close people"}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {loadingChannel && <p>Loading members…</p>}
        {details?.access === "workspace" && (
          <div className="channel-access-note">
            <strong>Open to everyone</strong>
            <p>
              {isAnnouncementChannel
                ? "Every active workspace member can read, reply in threads, and react. Workspace owners can post bulletins."
                : "Every active workspace member can read and send messages in this channel."}
            </p>
          </div>
        )}
        {details?.access === "humans" && (
          <div className="channel-access-note">
            <strong>Humans only</strong>
            <p>
              {isAnnouncementChannel
                ? "All people in the workspace can read, reply in threads, and react. Workspace owners can post bulletins. Agents and bots cannot access this channel."
                : "All people in the workspace can read and send messages. Agents and bots cannot access this channel."}
            </p>
          </div>
        )}
        {canManageChannel && conversationId !== null && upsert !== null && (
          <div className="channel-member-add">
            <label id="channel-member-add-label" htmlFor="channel-member-search">
              Add workspace members
            </label>
            <input
              ref={searchInputRef}
              id="channel-member-search"
              type="search"
              placeholder="Search by name, username, or title"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape in a search field clears the query; only an empty field lets the
                // keystroke bubble to the document listener that closes the dialog.
                if (event.key === "Escape" && searchQuery !== "") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchQuery("");
                }
              }}
            />
            {availableMembers.length === 0 ? (
              <p className="channel-member-add-empty" role="status">
                Everyone available is already here
              </p>
            ) : filteredMembers.length === 0 ? (
              <p className="channel-member-add-empty" role="status">
                No matches
              </p>
            ) : (
              <ul
                className="channel-member-add-options"
                role="group"
                aria-labelledby="channel-member-add-label"
              >
                {filteredMembers.map((member) => (
                  <li key={member.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checkedIds.has(member.id)}
                        onChange={() => toggleChecked(member.id)}
                      />
                      <span>{memberOptionLabel(member)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="channel-member-add-actions">
              <button
                type="button"
                disabled={checkedAvailableIds.length === 0}
                onClick={addCheckedMembers}
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
              const rowBusy = entry.pending || busyUserId === entry.user.id;
              const messageable = canMessage(entry.user);
              const openDirectMessage = (): void => {
                if (!messageable || rowBusy) return;
                onMessage(entry.user.id);
              };
              const identity = (
                <DirectoryIdentity
                  currentUserId={currentUserId}
                  presence={presenceByUser[entry.user.id] ?? "offline"}
                  user={entry.user}
                />
              );
              return (
                <li
                  key={entry.user.id}
                  className={[
                    "channel-member-row",
                    messageable ? "messageable" : "",
                    entry.pending ? "pending" : "",
                  ]
                    .filter((part) => part !== "")
                    .join(" ")}
                  aria-busy={entry.pending}
                  onClick={openDirectMessage}
                >
                  {messageable ? (
                    <button
                      type="button"
                      className="channel-member-open"
                      disabled={rowBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        openDirectMessage();
                      }}
                    >
                      {identity}
                    </button>
                  ) : (
                    identity
                  )}
                  {kind !== null && <span className="member-kind">{kind}</span>}
                  {entry.pending && <span className="channel-member-pending">Adding…</span>}
                  {showChannelRole && entry.role !== null && !entry.pending && (
                    <span className={`channel-role ${entry.role}`}>{entry.role}</span>
                  )}
                  <div
                    className="channel-member-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {messageable && (
                      <button
                        type="button"
                        disabled={rowBusy}
                        onClick={() => onMessage(entry.user.id)}
                      >
                        Message
                      </button>
                    )}
                    {canManageChannel &&
                      conversationId !== null &&
                      upsert !== null &&
                      remove !== null &&
                      entry.role !== null &&
                      !entry.pending && (
                        <>
                          <button
                            type="button"
                            disabled={rowBusy}
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
                            disabled={rowBusy}
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
          <button type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
