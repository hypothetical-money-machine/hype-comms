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
  const [details, setDetails] = useState<ChannelMembersResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isChannel = source === "channel";
  const conversationId = source === "channel" ? props.conversationId : null;
  const isAnnouncementChannel = source === "channel" && props.channelMode === "announcement";
  const load = source === "channel" ? props.load : null;
  const upsert = source === "channel" ? props.upsert : null;
  const remove = source === "channel" ? props.remove : null;

  useOpenChangeNotifier(true, onOpenChange);

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
        ref={dialogRef}
        className="channel-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busyUserId !== null}
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
                      {member.title !== null && member.title !== undefined
                        ? ` · ${member.title}`
                        : ""}
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
              const messageable = canMessage(entry.user);
              const openDirectMessage = (): void => {
                if (!messageable || busyUserId !== null) return;
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
                  className={messageable ? "channel-member-row messageable" : "channel-member-row"}
                  onClick={openDirectMessage}
                >
                  {messageable ? (
                    <button
                      type="button"
                      className="channel-member-open"
                      disabled={busyUserId !== null}
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
                  {showChannelRole && entry.role !== null && (
                    <span className={`channel-role ${entry.role}`}>{entry.role}</span>
                  )}
                  <div
                    className="channel-member-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {messageable && (
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
