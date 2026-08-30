import { useCallback, useEffect, useRef, useState } from "react";

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
  "listAgentEnrollments" | "reviewAgentEnrollment"
>;

type EnrollmentListState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
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

type ReviewDecision = "approve" | "reject";

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

function restrictedChannelLabel(
  channelId: string,
  conversations: HumanWorkspaceBootstrapResponse["conversations"],
): string {
  const conversation = conversations.find(
    (summary) => summary.conversation.id === channelId,
  )?.conversation;
  if (conversation?.name !== null && conversation?.name !== undefined) return conversation.name;
  if (conversation?.slug !== null && conversation?.slug !== undefined)
    return `#${conversation.slug}`;
  return `Private channel not visible to you (${channelId})`;
}

function pendingEnrollments(response: ListAgentEnrollmentsResponse): readonly AgentEnrollment[] {
  return response.enrollments.filter((enrollment) => enrollment.status === "pending_approval");
}

function EnrollmentCard({
  enrollment,
  members,
  conversations,
  confirmingApproval,
  reviewingDecision,
  onBeginApproval,
  onCancelApproval,
  onReview,
}: {
  readonly enrollment: AgentEnrollment;
  readonly members: readonly User[];
  readonly conversations: HumanWorkspaceBootstrapResponse["conversations"];
  readonly confirmingApproval: boolean;
  readonly reviewingDecision: ReviewDecision | null;
  readonly onBeginApproval: (enrollmentId: string) => void;
  readonly onCancelApproval: () => void;
  readonly onReview: (enrollment: AgentEnrollment, decision: ReviewDecision) => void;
}) {
  const busy = reviewingDecision !== null;
  return (
    <article className="agent-enrollment-card" aria-busy={busy}>
      <header className="agent-enrollment-card-header">
        <div>
          <h3>{enrollment.displayName}</h3>
          <p>@{enrollment.username}</p>
        </div>
        <span className="agent-enrollment-status">Pending approval</span>
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
                  <li key={channelId}>{restrictedChannelLabel(channelId, conversations)}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      {confirmingApproval && (
        <p className="agent-enrollment-confirmation" role="status">
          Approve {enrollment.displayName}? This grants the fixed agent profile, including
          permission to invite more agents.
        </p>
      )}
      <div className="agent-enrollment-actions">
        <button
          type="button"
          className={confirmingApproval ? "agent-enrollment-cancel" : "agent-enrollment-reject"}
          disabled={busy}
          onClick={confirmingApproval ? onCancelApproval : () => onReview(enrollment, "reject")}
        >
          {confirmingApproval ? "Cancel" : reviewingDecision === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          className="agent-enrollment-approve"
          disabled={busy}
          onClick={
            confirmingApproval
              ? () => onReview(enrollment, "approve")
              : () => onBeginApproval(enrollment.id)
          }
        >
          {confirmingApproval
            ? reviewingDecision === "approve"
              ? "Approving…"
              : "Confirm approval"
            : "Approve"}
        </button>
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
  const [state, setState] = useState<EnrollmentListState>({ status: "idle" });
  const [reviewingDecisions, setReviewingDecisions] = useState<ReadonlyMap<string, ReviewDecision>>(
    new Map(),
  );
  const [confirmingApprovalId, setConfirmingApprovalId] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);
  const mounted = useRef(false);
  const activeRef = useRef(active);
  const generation = useRef(0);
  const mutationRevision = useRef(0);
  const listRun = useRef<ListRun | null>(null);
  const trailingRefresh = useRef(false);
  const pollTimer = useRef<number | null>(null);
  const attentionRefreshTimer = useRef<number | null>(null);
  const reviewingIds = useRef(new Map<string, ReviewDecision>());
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
        reviewingIds.current.size > 0 ||
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
    [clearPoll],
  );

  const requestList = useCallback((): void => {
    if (!mounted.current || !activeRef.current) return;
    clearPoll();
    if (reviewingIds.current.size > 0) {
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
      previous.status === "ready" || previous.status === "refreshing"
        ? { status: "refreshing", enrollments: previous.enrollments }
        : { status: "loading" },
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
        setState({ status: "ready", enrollments: pendingEnrollments(response) });
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
        setState({
          status: "error",
          message: ipcErrorMessage(error, "Could not load agent requests."),
        });
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
  }, [clearPoll, client, schedulePoll]);

  useEffect(() => {
    requestListRef.current = requestList;
  }, [requestList]);

  const beginApproval = useCallback((enrollmentId: string): void => {
    if (reviewingIds.current.has(enrollmentId)) return;
    setReviewNotice(null);
    setConfirmingApprovalId(enrollmentId);
  }, []);

  const cancelApproval = useCallback((): void => {
    setConfirmingApprovalId(null);
  }, []);

  const review = useCallback(
    (enrollment: AgentEnrollment, decision: ReviewDecision): void => {
      if (!mounted.current || !activeRef.current || reviewingIds.current.has(enrollment.id)) return;
      reviewingIds.current.set(enrollment.id, decision);
      setReviewingDecisions(new Map(reviewingIds.current));
      setReviewNotice(null);
      clearPoll();
      // Lists that began before the review must not restore this row after the decision settles.
      mutationRevision.current += 1;

      void client
        .reviewAgentEnrollment(enrollment.id, decision)
        .then((response) => {
          if (!mounted.current) return;
          const expectedStatus = decision === "approve" ? "ready_to_redeem" : "rejected";
          setState((previous) =>
            previous.status === "ready" || previous.status === "refreshing"
              ? {
                  status: previous.status,
                  enrollments:
                    response.enrollment.status === "pending_approval"
                      ? previous.enrollments
                      : previous.enrollments.filter((candidate) => candidate.id !== enrollment.id),
                }
              : previous,
          );
          if (response.enrollment.status === expectedStatus) {
            setReviewNotice({
              tone: "success",
              message:
                decision === "approve"
                  ? `Approved ${enrollment.displayName}. The agent can now finish joining.`
                  : `Rejected ${enrollment.displayName}.`,
            });
          } else if (response.enrollment.status === "expired") {
            setReviewNotice({
              tone: "error",
              message: `${enrollment.displayName} expired before it could be ${
                decision === "approve" ? "approved" : "rejected"
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
            message: ipcErrorMessage(error, `Could not ${decision} ${enrollment.displayName}.`),
          });
        })
        .finally(() => {
          // This also invalidates a list that began while the review request was in flight.
          mutationRevision.current += 1;
          reviewingIds.current.delete(enrollment.id);
          if (mounted.current) {
            setReviewingDecisions(new Map(reviewingIds.current));
            setConfirmingApprovalId((current) => (current === enrollment.id ? null : current));
          }
          if (mounted.current && activeRef.current) {
            trailingRefresh.current = false;
            requestListRef.current();
          }
        });
    },
    [clearPoll, client],
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
      setState({ status: "loading" });
      requestListRef.current();
    } else if (reviewingIds.current.size === 0) {
      setConfirmingApprovalId(null);
      setReviewNotice(null);
    }
    return () => {
      if (generation.current === currentGeneration) generation.current += 1;
      activeRef.current = false;
      trailingRefresh.current = false;
      clearAttentionRefresh();
      clearPoll();
    };
  }, [active, clearAttentionRefresh, clearPoll, client]);

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

  const enrollments =
    state.status === "ready" || state.status === "refreshing" ? state.enrollments : [];

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
            agent enrollments. The joining agent keeps its own credential.
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
            aria-label="Pending agent requests"
            aria-busy={state.status === "refreshing"}
          >
            {enrollments.map((enrollment) => (
              <li key={enrollment.id}>
                <EnrollmentCard
                  enrollment={enrollment}
                  members={members}
                  conversations={conversations}
                  confirmingApproval={confirmingApprovalId === enrollment.id}
                  reviewingDecision={reviewingDecisions.get(enrollment.id) ?? null}
                  onBeginApproval={beginApproval}
                  onCancelApproval={cancelApproval}
                  onReview={review}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
