// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AgentEnrollment,
  AgentEnrollmentResponse,
  HumanWorkspaceBootstrapResponse,
  ListAgentEnrollmentsResponse,
  User,
} from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEnrollmentsView, type AgentEnrollmentsClient } from "./agent-enrollments-view";

const NOW = "2026-08-30T17:00:00.000Z";
const EXPIRES_AT = "2026-08-31T17:00:00.000Z";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";
const INVITER_ID = "10000000-0000-4000-8000-000000000003";
const ENROLLMENT_ID = "10000000-0000-4000-8000-000000000004";
const SECOND_ENROLLMENT_ID = "10000000-0000-4000-8000-000000000005";
const REVIEWED_ENROLLMENT_ID = "10000000-0000-4000-8000-000000000006";
const CHANNEL_ID = "10000000-0000-4000-8000-000000000007";
const MISSING_CHANNEL_ID = "10000000-0000-4000-8000-000000000008";
const MISSING_REQUESTER_ID = "10000000-0000-4000-8000-000000000009";

const inviter: User = {
  id: INVITER_ID,
  kind: "agent",
  username: "hermes",
  displayName: "Hermes",
  avatarUrl: null,
  title: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const conversations: HumanWorkspaceBootstrapResponse["conversations"] = [
  {
    conversation: {
      id: CHANNEL_ID,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name: "Launch room",
      slug: "launch-room",
      topic: null,
      access: "members",
      channelMode: "chat",
      isArchived: false,
      createdBy: OWNER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [OWNER_ID, INVITER_ID],
    membershipRole: "owner",
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  },
];

function enrollment(overrides: Partial<AgentEnrollment> = {}): AgentEnrollment {
  return {
    id: ENROLLMENT_ID,
    workspaceId: WORKSPACE_ID,
    profile: "default-agency-v1",
    status: "pending_approval",
    username: "atlas",
    displayName: "Atlas",
    label: "atlas-runtime",
    requestedBy: INVITER_ID,
    requestedByKind: "agent",
    restrictedChannelIds: [CHANNEL_ID, MISSING_CHANNEL_ID],
    expiresAt: EXPIRES_AT,
    reviewedBy: null,
    reviewedAt: null,
    activatedAgentUserId: null,
    activatedAgentTokenId: null,
    activatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reviewed(
  source: AgentEnrollment,
  decision: "approve" | "reject",
): AgentEnrollmentResponse {
  return {
    enrollment: {
      ...source,
      status: decision === "approve" ? "ready_to_redeem" : "rejected",
      reviewedBy: OWNER_ID,
      reviewedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function response(...enrollments: readonly AgentEnrollment[]): ListAgentEnrollmentsResponse {
  return { enrollments: [...enrollments] };
}

function clientWith(
  listAgentEnrollments: AgentEnrollmentsClient["listAgentEnrollments"],
  reviewAgentEnrollment: AgentEnrollmentsClient["reviewAgentEnrollment"] = async (
    enrollmentId,
    decision,
  ) => reviewed(enrollment({ id: enrollmentId }), decision),
  cancelAgentEnrollment: AgentEnrollmentsClient["cancelAgentEnrollment"] = async (
    enrollmentId,
  ) => ({
    enrollment: {
      ...enrollment({ id: enrollmentId, status: "ready_to_redeem" }),
      status: "cancelled",
    },
  }),
): AgentEnrollmentsClient {
  return { cancelAgentEnrollment, listAgentEnrollments, reviewAgentEnrollment };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function setVisibility(value: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function view(client: AgentEnrollmentsClient, active = true): ReturnType<typeof createElement> {
  return createElement(AgentEnrollmentsView, {
    client,
    members: [inviter],
    conversations,
    active,
  });
}

beforeEach(() => setVisibility("visible"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("AgentEnrollmentsView", () => {
  it("stays hidden and does not read or refresh while inactive", async () => {
    const listAgentEnrollments = vi.fn(async () => response());
    render(view(clientWith(listAgentEnrollments), false));

    expect(screen.getByTestId("agent-enrollments-view").hidden).toBe(true);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(listAgentEnrollments).not.toHaveBeenCalled();
  });

  it("renders open requests with owner-projected private channel names", async () => {
    const projected = enrollment({
      restrictedChannels: [
        { conversationId: CHANNEL_ID, name: "Launch room" },
        { conversationId: MISSING_CHANNEL_ID, name: "Private roadmap" },
      ],
    });
    const missingRequester = enrollment({
      id: SECOND_ENROLLMENT_ID,
      username: "luna",
      displayName: "Luna",
      label: "luna-runtime",
      requestedBy: MISSING_REQUESTER_ID,
      requestedByKind: "human",
      restrictedChannelIds: [],
      restrictedChannels: [],
    });
    const readyToJoin = enrollment({
      id: REVIEWED_ENROLLMENT_ID,
      username: "ready",
      displayName: "Ready teammate",
      status: "ready_to_redeem",
      restrictedChannelIds: [],
      restrictedChannels: [],
    });
    const rejected = enrollment({
      id: "10000000-0000-4000-8000-000000000010",
      username: "rejected",
      displayName: "Rejected request",
      status: "rejected",
      restrictedChannelIds: [],
    });
    const listAgentEnrollments = vi.fn(async () =>
      response(projected, missingRequester, readyToJoin, rejected),
    );

    render(view(clientWith(listAgentEnrollments)));

    expect(screen.getByRole("status").textContent).toContain("Loading agent requests");
    const atlasCard = (await screen.findByRole("heading", { name: "Atlas" })).closest("article");
    if (atlasCard === null) throw new Error("Atlas card is missing");
    expect(within(atlasCard).getByText("@atlas")).toBeTruthy();
    expect(within(atlasCard).getByText("Hermes (@hermes) · Agent")).toBeTruthy();
    expect(within(atlasCard).getByText("atlas-runtime")).toBeTruthy();
    expect(within(atlasCard).getByText("Launch room")).toBeTruthy();
    expect(within(atlasCard).getByText("Private roadmap")).toBeTruthy();
    const lunaCard = screen.getByRole("heading", { name: "Luna" }).closest("article");
    if (lunaCard === null) throw new Error("Luna card is missing");
    expect(within(lunaCard).getByText(`Human ${MISSING_REQUESTER_ID}`)).toBeTruthy();
    expect(within(lunaCard).getByText("None requested")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ready teammate" })).toBeTruthy();
    expect(screen.getByText("Ready to join")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel invitation" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Rejected request" })).toBeNull();
    expect(document.querySelector(`time[datetime="${NOW}"]`)).not.toBeNull();
    expect(document.querySelector(`time[datetime="${EXPIRES_AT}"]`)).not.toBeNull();
    expect(screen.getByText(/permission to request further agent enrollments/)).toBeTruthy();
  });

  it("keeps the UUID fallback for an older server without channel details", async () => {
    const legacy = enrollment({
      restrictedChannelIds: [MISSING_CHANNEL_ID],
      restrictedChannels: undefined,
    });
    render(view(clientWith(async () => response(legacy))));

    await screen.findByRole("heading", { name: "Atlas" });
    expect(
      screen.getByText(`Private channel not visible to you (${MISSING_CHANNEL_ID})`),
    ).toBeTruthy();
  });

  it("keeps pending rows visible, reports a failed refresh, and recovers", async () => {
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(enrollment()))
      .mockRejectedValueOnce(new Error("An active workspace owner session is required"))
      .mockResolvedValueOnce(response());
    render(view(clientWith(listAgentEnrollments)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "An active workspace owner session is required",
    );
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("approves once per row, keeps the ready invitation, and refreshes the queue", async () => {
    const request = enrollment();
    const approved = reviewed(request, "approve").enrollment;
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response(approved));
    const confirmRef: { current: HTMLElement | null } = { current: null };
    let attemptedReentry = false;
    const reviewAgentEnrollment = vi.fn(() => {
      if (!attemptedReentry) {
        attemptedReentry = true;
        if (confirmRef.current !== null) fireEvent.click(confirmRef.current);
      }
      return reviewGate.promise;
    });
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    expect(reviewAgentEnrollment).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      "Approve Atlas? This grants the fixed agent profile",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(reviewAgentEnrollment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const confirm = screen.getByRole("button", { name: "Confirm approval" });
    confirmRef.current = confirm;
    fireEvent.click(confirm);
    expect(reviewAgentEnrollment).toHaveBeenCalledTimes(1);
    expect(reviewAgentEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, "approve");
    expect(confirm.textContent).toBe("Approving…");
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      reviewGate.resolve({ enrollment: approved });
      await reviewGate.promise;
    });

    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
    expect(screen.getByText("Ready to join")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel invitation" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Approved Atlas. You can cancel the invitation until the teammate joins.",
    );
  });

  it("labels only the selected rejection while its review is in flight", async () => {
    const request = enrollment();
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response());
    const reviewAgentEnrollment = vi.fn(() => reviewGate.promise);
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.getByRole("button", { name: "Rejecting…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      reviewGate.resolve(reviewed(request, "reject"));
      await reviewGate.promise;
    });
    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
  });

  it("confirms and cancels a ready invitation once", async () => {
    const ready = reviewed(enrollment(), "approve").enrollment;
    const cancelled = { ...ready, status: "cancelled" } as const;
    const cancelGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(ready))
      .mockResolvedValueOnce(response());
    const confirmRef: { current: HTMLElement | null } = { current: null };
    let attemptedReentry = false;
    const cancelAgentEnrollment = vi.fn(() => {
      if (!attemptedReentry) {
        attemptedReentry = true;
        if (confirmRef.current !== null) fireEvent.click(confirmRef.current);
      }
      return cancelGate.promise;
    });
    render(view(clientWith(listAgentEnrollments, undefined, cancelAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    expect(cancelAgentEnrollment).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      "Cancel Atlas's invitation? The teammate will no longer be able to join",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep invitation" }));
    expect(cancelAgentEnrollment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    const confirm = screen.getByRole("button", { name: "Confirm cancellation" });
    confirmRef.current = confirm;
    fireEvent.click(confirm);
    expect(cancelAgentEnrollment).toHaveBeenCalledTimes(1);
    expect(cancelAgentEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID);
    expect(confirm.textContent).toBe("Cancelling…");
    expect(screen.getByRole("button", { name: "Keep invitation" }).hasAttribute("disabled")).toBe(
      true,
    );

    await act(async () => {
      cancelGate.resolve({ enrollment: cancelled });
      await cancelGate.promise;
    });

    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Cancelled Atlas's invitation. The teammate can no longer join with it.",
    );
  });

  it("keeps a cancellation race visible until the authoritative list removes the row", async () => {
    const ready = reviewed(enrollment(), "approve").enrollment;
    const active = {
      ...ready,
      status: "active",
      activatedAgentUserId: SECOND_ENROLLMENT_ID,
      activatedAgentTokenId: REVIEWED_ENROLLMENT_ID,
      activatedAt: NOW,
    } as const;
    const reconciledList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(ready))
      .mockImplementationOnce(() => reconciledList.promise);
    const cancelAgentEnrollment = vi.fn(async () => {
      throw new Error("Agent enrollment can no longer be cancelled");
    });
    render(view(clientWith(listAgentEnrollments, undefined, cancelAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Agent enrollment can no longer be cancelled",
    );
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
    await act(async () => {
      reconciledList.resolve(response(active));
      await reconciledList.promise;
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent enrollment can no longer be cancelled",
    );
  });

  it("keeps a completed review notice across navigation, then clears it on the next departure", async () => {
    const request = enrollment();
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValue(response());
    const client = clientWith(listAgentEnrollments, () => reviewGate.promise);
    const { rerender } = render(view(client));
    await screen.findByRole("heading", { name: "Atlas" });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));

    rerender(view(client, false));
    await act(async () => {
      reviewGate.resolve(reviewed(request, "approve"));
      await reviewGate.promise;
    });
    const success = "Approved Atlas. You can cancel the invitation until the teammate joins.";
    await waitFor(() => expect(screen.getByText(success)).toBeTruthy());

    rerender(view(client));
    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toContain(success);

    rerender(view(client, false));
    await waitFor(() => expect(screen.queryByText(success)).toBeNull());
  });

  it("keeps a review error that settles while the queue is hidden", async () => {
    const request = enrollment();
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const client = clientWith(
      async () => response(request),
      () => reviewGate.promise,
    );
    const { rerender } = render(view(client));
    await screen.findByRole("heading", { name: "Atlas" });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    rerender(view(client, false));
    await act(async () => {
      reviewGate.reject(
        new Error(
          "Error invoking remote method 'workspace:agent-enrollment-review': " +
            "WorkspaceRequestError: Agent enrollment can no longer be reviewed",
        ),
      );
      await reviewGate.promise.catch(() => undefined);
    });

    rerender(view(client));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Agent enrollment can no longer be reviewed",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("Error invoking remote method");
  });

  it("does not report approval when the request expires during review", async () => {
    const request = enrollment();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response());
    const reviewAgentEnrollment = vi.fn(async (): Promise<AgentEnrollmentResponse> => ({
      enrollment: { ...request, status: "expired", updatedAt: EXPIRES_AT },
    }));
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Atlas expired before it could be approved.",
    );
    expect(screen.queryByText(/Approved Atlas/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
  });

  it("keeps a rejected review failure visible and reconciles with a trailing list", async () => {
    const request = enrollment();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response(request));
    const reviewAgentEnrollment = vi.fn(async () => {
      throw new Error("Agent enrollment can no longer be reviewed");
    });
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Agent enrollment can no longer be reviewed",
    );
    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
    expect(reviewAgentEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, "reject");
  });

  it("starts each poll after the previous list settles and refreshes on visibility and focus", async () => {
    vi.useFakeTimers();
    const firstList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockImplementationOnce(() => firstList.promise)
      .mockResolvedValue(response());
    const client = clientWith(listAgentEnrollments);
    const { rerender } = render(view(client));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstList.resolve(response());
      await firstList.promise;
    });
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await act(async () => vi.advanceTimersByTime(99));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);

    rerender(view(client, false));
    window.dispatchEvent(new Event("focus"));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);
  });

  it("does not schedule a poll while a mutation is in flight", async () => {
    vi.useFakeTimers();
    const request = enrollment();
    const staleList = deferred<ListAgentEnrollmentsResponse>();
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockImplementationOnce(() => staleList.promise)
      .mockResolvedValueOnce(response());
    render(view(clientWith(listAgentEnrollments, () => reviewGate.promise)));
    await act(async () => Promise.resolve());
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await act(async () => {
      staleList.resolve(response(request));
      await staleList.promise;
    });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);

    await act(async () => {
      reviewGate.resolve(reviewed(request, "reject"));
      await reviewGate.promise;
      await Promise.resolve();
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);
  });

  it("coalesces overlapping refresh requests into one trailing read", async () => {
    const firstList = deferred<ListAgentEnrollmentsResponse>();
    const secondList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockImplementationOnce(() => firstList.promise)
      .mockImplementationOnce(() => secondList.promise);
    render(view(clientWith(listAgentEnrollments)));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    window.dispatchEvent(new Event("focus"));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstList.resolve(response());
      await firstList.promise;
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);
    await act(async () => {
      secondList.resolve(response());
      await secondList.promise;
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale pre-review list replace an approved row", async () => {
    const request = enrollment();
    const approved = reviewed(request, "approve").enrollment;
    const staleList = deferred<ListAgentEnrollmentsResponse>();
    const postReviewList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockImplementationOnce(() => staleList.promise)
      .mockImplementationOnce(() => postReviewList.promise);
    const reviewAgentEnrollment = vi.fn(async () => ({ enrollment: approved }));
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    await screen.findByText("Ready to join");

    await act(async () => {
      staleList.resolve(response(request));
      await staleList.promise;
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Ready to join")).toBeTruthy();

    await act(async () => {
      postReviewList.resolve(response(approved));
      await postReviewList.promise;
    });
    expect(screen.getByText("Ready to join")).toBeTruthy();
  });

  it("does not let a stale pre-cancellation list restore a cancelled row", async () => {
    const ready = reviewed(enrollment(), "approve").enrollment;
    const cancelled = { ...ready, status: "cancelled" } as const;
    const staleList = deferred<ListAgentEnrollmentsResponse>();
    const postCancelList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(ready))
      .mockImplementationOnce(() => staleList.promise)
      .mockImplementationOnce(() => postCancelList.promise);
    const cancelAgentEnrollment = vi.fn(async () => ({ enrollment: cancelled }));
    render(view(clientWith(listAgentEnrollments, undefined, cancelAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull());

    await act(async () => {
      staleList.resolve(response(ready));
      await staleList.promise;
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();

    await act(async () => {
      postCancelList.resolve(response());
      await postCancelList.promise;
    });
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
  });

  it("ignores a late list after unmount and schedules no poll", async () => {
    vi.useFakeTimers();
    const lateList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi.fn(() => lateList.promise);
    const { unmount } = render(view(clientWith(listAgentEnrollments)));
    unmount();

    await act(async () => {
      lateList.resolve(response(enrollment()));
      await lateList.promise;
    });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
  });
});
