import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type {
  AgentEnrollment,
  HumanWorkspaceBootstrapResponse,
  ListAgentEnrollmentsResponse,
  User,
} from "@hype-comms/contracts";

import type { DesktopApi } from "../../shared/desktop-api";
import { ipcErrorMessage } from "./ipc-error-message";

export type AgentEnrollmentsClient = Pick<
  DesktopApi,
  "cancelAgentEnrollment" | "listAgentEnrollments" | "reviewAgentEnrollment"
>;

type EnrollmentListState =
  | { readonly status: "idle"; readonly enrollments: readonly AgentEnrollment[] }
  | { readonly status: "loading"; readonly enrollments: readonly AgentEnrollment[] }
  | {
      readonly status: "error";
      readonly message: string;
      readonly enrollments: readonly AgentEnrollment[];
    }
  | { readonly status: "ready"; readonly enrollments: readonly AgentEnrollment[] }
  | { readonly status: "refreshing"; readonly enrollments: readonly AgentEnrollment[] };

interface ListRun {
  readonly generation: number;
  readonly mutationRevision: number;
}

interface ReviewNotice {
  readonly tone: "success" | "error";
  readonly message: string;
}

type EnrollmentMutationAction = "approve" | "reject" | "cancel";
type ConfirmationAction = Extract<EnrollmentMutationAction, "approve" | "cancel">;

interface Confirmation {
  readonly enrollmentId: string;
  readonly action: ConfirmationAction;
}

interface EnrollmentMutationStore {
  readonly begin: (enrollmentId: string, action: EnrollmentMutationAction) => boolean;
  readonly finish: (enrollmentId: string) => void;
  readonly getSnapshot: () => ReadonlyMap<string, EnrollmentMutationAction>;
  readonly subscribe: (listener: () => void) => () => void;
}

const POLL_DELAY_MS = 30_000;
const ATTENTION_REFRESH_DELAY_MS = 100;

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function requesterName(enrollment: AgentEnrollment, members: readonly User[]): string {
  const member = members.find((candidate) => candidate.id === enrollment.requestedBy);
  const kind = enrollment.requestedByKind === "agent" ? "Agent" : "Human";
  return member === undefined
    ? `${kind} ${enrollment.requestedBy}`
    : `${member.displayName} (@${member.username}) · ${kind}`;
}

function createEnrollmentMutationStore(): EnrollmentMutationStore {
  let snapshot: ReadonlyMap<string, EnrollmentMutationAction> = new Map();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, EnrollmentMutationAction>): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    begin: (enrollmentId, action) => {
      if (snapshot.has(enrollmentId)) return false;
      publish(new Map(snapshot).set(enrollmentId, action));
      return true;
    },
    finish: (enrollmentId) => {
      if (!snapshot.has(enrollmentId)) return;
      const next = new Map(snapshot);
      next.delete(enrollmentId);
      publish(next);
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function restrictedChannelLabel(
  channelId: string,
  enrollment: AgentEnrollment,
  conversations: HumanWorkspaceBootstrapResponse["conversations"],
): string {
  const projected = enrollment.restrictedChannels?.find(
    (channel) => channel.conversationId === channelId,
  );
  if (projected !== undefined) return projected.name;
  const conversation = conversations.find(
    (summary) => summary.conversation.id === channelId,
  )?.conversation;
  if (conversation?.name !== null && conversation?.name !== undefined) return conversation.name;
  if (conversation?.slug !== null && conversation?.slug !== undefined)
    return `#${conversation.slug}`;
  return `Private channel not visible to you (${channelId})`;
}

function openEnrollments(response: ListAgentEnrollmentsResponse): readonly AgentEnrollment[] {
  return response.enrollments.filter(
    (enrollment) =>
      enrollment.status === "pending_approval" || enrollment.status === "ready_to_redeem",
  );
}

function EnrollmentCard({
  enrollment,
  members,
  conversations,
  confirmationAction,
  mutationAction,
  onBeginConfirmation,
  onCancelConfirmation,
  onMutate,
}: {
  readonly enrollment: AgentEnrollment;
  readonly members: readonly User[];
  readonly conversations: HumanWorkspaceBootstrapResponse["conversations"];
  readonly confirmationAction: ConfirmationAction | null;
  readonly mutationAction: EnrollmentMutationAction | null;
  readonly onBeginConfirmation: (enrollmentId: string, action: ConfirmationAction) => void;
  readonly onCancelConfirmation: () => void;
  readonly onMutate: (enrollment: AgentEnrollment, action: EnrollmentMutationAction) => void;
}) {
  const busy = mutationAction !== null;
  const readyToJoin = enrollment.status === "ready_to_redeem";
  return (
    <article className="agent-enrollment-card" aria-busy={busy}>
      <header className="agent-enrollment-card-header">
        <div>
          <h3>{enrollment.displayName}</h3>
          <p>@{enrollment.username}</p>
        </div>
        <span
          className={`agent-enrollment-status${readyToJoin ? " agent-enrollment-status-ready" : ""}`}
        >
          {readyToJoin ? "Ready to join" : "Pending approval"}
        </span>
      </header>
      <dl className="agent-enrollment-details">
        <div>
          <dt>Requested by</dt>
          <dd>{requesterName(enrollment, members)}</dd>
        </div>
        <div>
          <dt>Credential label</dt>
          <dd>{enrollment.label}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>
            <time dateTime={enrollment.createdAt}>{formatDateTime(enrollment.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <time dateTime={enrollment.expiresAt}>{formatDateTime(enrollment.expiresAt)}</time>
          </dd>
        </div>
        <div className="agent-enrollment-channels">
          <dt>Restricted channels</dt>
          <dd>
            {enrollment.restrictedChannelIds.length === 0 ? (
              "None requested"
            ) : (
              <ul>
                {enrollment.restrictedChannelIds.map((channelId) => (
                  <li key={channelId}>
                    {restrictedChannelLabel(channelId, enrollment, conversations)}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      {confirmationAction !== null && (
        <p
          className={`agent-enrollment-confirmation${
            confirmationAction === "cancel" ? " agent-enrollment-confirmation-danger" : ""
          }`}
          role="status"
        >
          {confirmationAction === "approve" ? (
            <>
              Approve {enrollment.displayName}? This grants the fixed agent profile, including
              permission to invite more agents.
            </>
          ) : (
            <>
              Cancel {enrollment.displayName}&apos;s invitation? The teammate will no longer be able
              to join with this enrollment.
            </>
          )}
        </p>
      )}
      <div className="agent-enrollment-actions">
        {readyToJoin ? (
          <>
            {confirmationAction === "cancel" && (
              <button
                type="button"
                className="agent-enrollment-cancel"
                disabled={busy}
                onClick={onCancelConfirmation}
              >
                Keep invitation
              </button>
            )}
            <button
              type="button"
              className="agent-enrollment-cancel-invitation"
              disabled={busy}
              onClick={
                confirmationAction === "cancel"
                  ? () => onMutate(enrollment, "cancel")
                  : () => onBeginConfirmation(enrollment.id, "cancel")
              }
            >
              {mutationAction === "cancel"
                ? "Cancelling…"
                : confirmationAction === "cancel"
                  ? "Confirm cancellation"
                  : "Cancel invitation"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={
                confirmationAction === "approve"
                  ? "agent-enrollment-cancel"
                  : "agent-enrollment-reject"
              }
              disabled={busy}
              onClick={
                confirmationAction === "approve"
                  ? onCancelConfirmation
                  : () => onMutate(enrollment, "reject")
              }
            >
              {confirmationAction === "approve"
                ? "Cancel"
                : mutationAction === "reject"
                  ? "Rejecting…"
                  : "Reject"}
            </button>
            <button
              type="button"
              className="agent-enrollment-approve"
              disabled={busy}
              onClick={
                confirmationAction === "approve"
                  ? () => onMutate(enrollment, "approve")
                  : () => onBeginConfirmation(enrollment.id, "approve")
              }
            >
              {confirmationAction === "approve"
                ? mutationAction === "approve"
                  ? "Approving…"
                  : "Confirm approval"
                : "Approve"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function AgentEnrollmentsView({
  client,
  members,
  conversations,
  active,
}: {
  readonly client: AgentEnrollmentsClient;
  readonly members: readonly User[];
  readonly conversations: HumanWorkspaceBootstrapResponse["conversations"];
  readonly active: boolean;
}) {
  const [state, setState] = useState<EnrollmentListState>({ status: "idle", enrollments: [] });
  const [mutationStore] = useState(createEnrollmentMutationStore);
  const mutationActions = useSyncExternalStore(
    mutationStore.subscribe,
    mutationStore.getSnapshot,
    mutationStore.getSnapshot,
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);
  const mounted = useRef(false);
  const activeRef = useRef(active);
  const generation = useRef(0);
  const mutationRevision = useRef(0);
  const listRun = useRef<ListRun | null>(null);
  const trailingRefresh = useRef(false);
  const pollTimer = useRef<number | null>(null);
  const attentionRefreshTimer = useRef<number | null>(null);
  const requestListRef = useRef<() => void>(() => undefined);

  const clearPoll = useCallback((): void => {
    if (pollTimer.current === null) return;
    window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const clearAttentionRefresh = useCallback((): void => {
    if (attentionRefreshTimer.current === null) return;
    window.clearTimeout(attentionRefreshTimer.current);
    attentionRefreshTimer.current = null;
  }, []);

  const schedulePoll = useCallback(
    (expectedGeneration: number): void => {
      clearPoll();
      if (
        !mounted.current ||
        !activeRef.current ||
        generation.current !== expectedGeneration ||
        mutationStore.getSnapshot().size > 0 ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      pollTimer.current = window.setTimeout(() => {
        pollTimer.current = null;
        if (
          mounted.current &&
          activeRef.current &&
          generation.current === expectedGeneration &&
          document.visibilityState !== "hidden"
        ) {
          requestListRef.current();
        }
      }, POLL_DELAY_MS);
    },
    [clearPoll, mutationStore],
  );

  const requestList = useCallback((): void => {
    if (!mounted.current || !activeRef.current) return;
    clearPoll();
    if (mutationStore.getSnapshot().size > 0) {
      trailingRefresh.current = true;
      return;
    }
    if (listRun.current !== null) {
      trailingRefresh.current = true;
      return;
    }

    const run: ListRun = {
      generation: generation.current,
      mutationRevision: mutationRevision.current,
    };
    listRun.current = run;
    setState((previous) =>
      previous.enrollments.length > 0
        ? { status: "refreshing", enrollments: previous.enrollments }
        : { status: "loading", enrollments: [] },
    );

    void client
      .listAgentEnrollments()
      .then((response) => {
        if (
          !mounted.current ||
          !activeRef.current ||
          generation.current !== run.generation ||
          mutationRevision.current !== run.mutationRevision
        ) {
          return;
        }
        setState({ status: "ready", enrollments: openEnrollments(response) });
      })
      .catch((error: unknown) => {
        if (
          !mounted.current ||
          !activeRef.current ||
          generation.current !== run.generation ||
          mutationRevision.current !== run.mutationRevision
        ) {
          return;
        }
        setState((previous) => ({
          status: "error",
          message: ipcErrorMessage(error, "Could not load agent requests."),
          enrollments: previous.enrollments,
        }));
      })
      .finally(() => {
        if (listRun.current === run) listRun.current = null;
        if (!mounted.current) return;
        if (trailingRefresh.current && activeRef.current) {
          trailingRefresh.current = false;
          requestListRef.current();
          return;
        }
        schedulePoll(generation.current);
      });
  }, [clearPoll, client, mutationStore, schedulePoll]);

  useEffect(() => {
    requestListRef.current = requestList;
  }, [requestList]);

  const beginConfirmation = useCallback(
    (enrollmentId: string, action: ConfirmationAction): void => {
      if (mutationStore.getSnapshot().has(enrollmentId)) return;
      setReviewNotice(null);
      setConfirmation({ enrollmentId, action });
    },
    [mutationStore],
  );

  const cancelConfirmation = useCallback((): void => {
    setConfirmation(null);
  }, []);

  const mutateEnrollment = useCallback(
    (enrollment: AgentEnrollment, action: EnrollmentMutationAction): void => {
      if (!mounted.current || !activeRef.current) return;
      if (!mutationStore.begin(enrollment.id, action)) return;
      setReviewNotice(null);
      clearPoll();
      // Lists that began before the mutation must not restore stale row state after it settles.
      mutationRevision.current += 1;

      const mutation =
        action === "cancel"
          ? client.cancelAgentEnrollment(enrollment.id)
          : client.reviewAgentEnrollment(enrollment.id, action);
      void mutation
        .then((response) => {
          if (!mounted.current) return;
          const expectedStatus =
            action === "approve"
              ? "ready_to_redeem"
              : action === "reject"
                ? "rejected"
                : "cancelled";
          const returned = response.enrollment;
          const returnedIsOpen =
            returned.status === "pending_approval" || returned.status === "ready_to_redeem";
          const replacement =
            returnedIsOpen &&
            returned.restrictedChannels === undefined &&
            enrollment.restrictedChannels !== undefined
              ? { ...returned, restrictedChannels: enrollment.restrictedChannels }
              : returned;
          setState((previous) => ({
            ...previous,
            enrollments: returnedIsOpen
              ? previous.enrollments.map((candidate) =>
                  candidate.id === enrollment.id ? replacement : candidate,
                )
              : previous.enrollments.filter((candidate) => candidate.id !== enrollment.id),
          }));
          if (response.enrollment.status === expectedStatus) {
            setReviewNotice({
              tone: "success",
              message:
                action === "approve"
                  ? `Approved ${enrollment.displayName}. You can cancel the invitation until the teammate joins.`
                  : action === "reject"
                    ? `Rejected ${enrollment.displayName}.`
                    : `Cancelled ${enrollment.displayName}'s invitation. The teammate can no longer join with it.`,
            });
          } else if (response.enrollment.status === "expired") {
            setReviewNotice({
              tone: "error",
              message:
                action === "cancel"
                  ? `${enrollment.displayName} expired before the invitation could be cancelled.`
                  : `${enrollment.displayName} expired before it could be ${
                      action === "approve" ? "approved" : "rejected"
                    }.`,
            });
          } else {
            setReviewNotice({
              tone: "error",
              message: `The server did not confirm the decision for ${enrollment.displayName}.`,
            });
          }
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          setReviewNotice({
            tone: "error",
            message: ipcErrorMessage(
              error,
              action === "cancel"
                ? `Could not cancel ${enrollment.displayName}'s invitation.`
                : `Could not ${action} ${enrollment.displayName}.`,
            ),
          });
        })
        .finally(() => {
          // This also invalidates a list that began while the mutation was in flight.
          mutationRevision.current += 1;
          mutationStore.finish(enrollment.id);
          if (mounted.current) {
            setConfirmation((current) =>
              current?.enrollmentId === enrollment.id ? null : current,
            );
          }
          if (mounted.current && activeRef.current) {
            trailingRefresh.current = false;
            requestListRef.current();
          }
        });
    },
    [clearPoll, client, mutationStore],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRef.current = false;
      generation.current += 1;
      trailingRefresh.current = false;
      clearAttentionRefresh();
      clearPoll();
    };
  }, [clearAttentionRefresh, clearPoll]);

  useEffect(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    activeRef.current = active;
    trailingRefresh.current = false;
    clearAttentionRefresh();
    clearPoll();
    if (active) {
      setState({ status: "loading", enrollments: [] });
      requestListRef.current();
    } else if (mutationStore.getSnapshot().size === 0) {
      setConfirmation(null);
      setReviewNotice(null);
    }
    return () => {
      if (generation.current === currentGeneration) generation.current += 1;
      activeRef.current = false;
      trailingRefresh.current = false;
      clearAttentionRefresh();
      clearPoll();
    };
  }, [active, clearAttentionRefresh, clearPoll, client, mutationStore]);

  useEffect(() => {
    const refreshAfterAttentionSettles = (): void => {
      clearAttentionRefresh();
      clearPoll();
      if (!activeRef.current || document.visibilityState === "hidden") return;
      attentionRefreshTimer.current = window.setTimeout(() => {
        attentionRefreshTimer.current = null;
        if (activeRef.current && document.visibilityState !== "hidden") {
          requestListRef.current();
        }
      }, ATTENTION_REFRESH_DELAY_MS);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        clearAttentionRefresh();
        clearPoll();
      } else {
        refreshAfterAttentionSettles();
      }
    };
    window.addEventListener("focus", refreshAfterAttentionSettles);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshAfterAttentionSettles);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearAttentionRefresh();
    };
  }, [clearAttentionRefresh, clearPoll]);

  const enrollments = state.enrollments;

  return (
    <section
      className="agent-enrollments-view"
      aria-labelledby="agent-enrollments-title"
      hidden={!active}
      data-testid="agent-enrollments-view"
    >
      <header className="unreads-header">
        <div>
          <h2 id="agent-enrollments-title">Agent requests</h2>
          <p className="unreads-subtitle">
            Approval grants the fixed default agent profile, including permission to request further
            agent enrollments. Approved invitations remain here until the teammate joins, expires,
            or you cancel them. The joining agent keeps its own credential.
          </p>
        </div>
        <button type="button" className="communication-paths-refresh" onClick={requestList}>
          Refresh
        </button>
      </header>
      <div className="agent-enrollments-body">
        {state.status === "loading" && <p role="status">Loading agent requests…</p>}
        {state.status === "error" && (
          <p className="agent-enrollments-error" role="alert">
            {state.message}
          </p>
        )}
        {reviewNotice !== null && (
          <p
            className={`agent-enrollments-review-${reviewNotice.tone}`}
            role={reviewNotice.tone === "error" ? "alert" : "status"}
          >
            {reviewNotice.message}
          </p>
        )}
        {(state.status === "ready" || state.status === "refreshing") &&
          enrollments.length === 0 && (
            <div className="empty-state agent-enrollments-empty-state">
              <h3>No agent requests waiting</h3>
              <p>New requests from eligible agents will appear here for review.</p>
            </div>
          )}
        {enrollments.length > 0 && (
          <ol
            className="agent-enrollment-list"
            aria-label="Open agent requests"
            aria-busy={state.status === "refreshing"}
          >
            {enrollments.map((enrollment) => (
              <li key={enrollment.id}>
                <EnrollmentCard
                  enrollment={enrollment}
                  members={members}
                  conversations={conversations}
                  confirmationAction={
                    confirmation?.enrollmentId === enrollment.id ? confirmation.action : null
                  }
                  mutationAction={mutationActions.get(enrollment.id) ?? null}
                  onBeginConfirmation={beginConfirmation}
                  onCancelConfirmation={cancelConfirmation}
                  onMutate={mutateEnrollment}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
