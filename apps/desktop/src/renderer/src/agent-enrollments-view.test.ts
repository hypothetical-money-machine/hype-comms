// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
): AgentEnrollmentsClient {
  return { listAgentEnrollments, reviewAgentEnrollment };
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

  it("renders pending requests with requester, dates, and every restricted channel", async () => {
    const missingRequester = enrollment({
      id: SECOND_ENROLLMENT_ID,
      username: "luna",
      displayName: "Luna",
      label: "luna-runtime",
      requestedBy: MISSING_REQUESTER_ID,
      requestedByKind: "human",
      restrictedChannelIds: [],
    });
    const alreadyReviewed = enrollment({
      id: REVIEWED_ENROLLMENT_ID,
      username: "settled",
      displayName: "Settled request",
      status: "ready_to_redeem",
      restrictedChannelIds: [],
    });
    const listAgentEnrollments = vi.fn(async () =>
      response(enrollment(), missingRequester, alreadyReviewed),
    );

    render(view(clientWith(listAgentEnrollments)));

    expect(screen.getByRole("status").textContent).toContain("Loading agent requests");
    await screen.findByRole("heading", { name: "Atlas" });
    expect(screen.getByText("@atlas")).toBeTruthy();
    expect(screen.getByText("Hermes (@hermes) · Agent")).toBeTruthy();
    expect(screen.getByText("atlas-runtime")).toBeTruthy();
    expect(screen.getByText("Launch room")).toBeTruthy();
    expect(
      screen.getByText(`Private channel not visible to you (${MISSING_CHANNEL_ID})`),
    ).toBeTruthy();
    expect(screen.getByText(`Human ${MISSING_REQUESTER_ID}`)).toBeTruthy();
    expect(screen.getByText("None requested")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Settled request" })).toBeNull();
    expect(document.querySelector(`time[datetime="${NOW}"]`)).not.toBeNull();
    expect(document.querySelector(`time[datetime="${EXPIRES_AT}"]`)).not.toBeNull();
    expect(screen.getByText(/permission to request further agent enrollments/)).toBeTruthy();
  });

  it("clears the pending rows when a refresh fails", async () => {
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(enrollment()))
      .mockRejectedValueOnce(new Error("An active workspace owner session is required"));
    render(view(clientWith(listAgentEnrollments)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "An active workspace owner session is required",
    );
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
  });

  it("approves once per row, removes the row, and refreshes the queue", async () => {
    const request = enrollment();
    const reviewGate = deferred<AgentEnrollmentResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response());
    const reviewAgentEnrollment = vi.fn(() => reviewGate.promise);
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
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(reviewAgentEnrollment).toHaveBeenCalledTimes(1);
    expect(reviewAgentEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, "approve");
    expect(confirm.textContent).toBe("Approving…");
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      reviewGate.resolve(reviewed(request, "approve"));
      await reviewGate.promise;
    });

    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Approved Atlas. The agent can now finish joining.",
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
    const success = "Approved Atlas. The agent can now finish joining.";
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

  it("does not schedule a poll while a review is in flight", async () => {
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

  it("does not let a stale pre-review list restore an approved row", async () => {
    const request = enrollment();
    const staleList = deferred<ListAgentEnrollmentsResponse>();
    const postReviewList = deferred<ListAgentEnrollmentsResponse>();
    const listAgentEnrollments = vi
      .fn<AgentEnrollmentsClient["listAgentEnrollments"]>()
      .mockResolvedValueOnce(response(request))
      .mockImplementationOnce(() => staleList.promise)
      .mockImplementationOnce(() => postReviewList.promise);
    const reviewAgentEnrollment = vi.fn(async () => reviewed(request, "approve"));
    render(view(clientWith(listAgentEnrollments, reviewAgentEnrollment)));
    await screen.findByRole("heading", { name: "Atlas" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(listAgentEnrollments).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull());

    await act(async () => {
      staleList.resolve(response(request));
      await staleList.promise;
    });
    expect(listAgentEnrollments).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();

    await act(async () => {
      postReviewList.resolve(response());
      await postReviewList.promise;
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
