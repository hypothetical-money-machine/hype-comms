// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommunicationPathsResponse, User } from "@hype-comms/contracts";

import type { CommunicationPathsClient } from "./communication-paths-view";
import { CommunicationPathsView } from "./communication-paths-view";

afterEach(cleanup);

const now = "2026-08-20T12:00:00.000Z";

const members: User[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "human",
    username: "morgan",
    displayName: "Morgan",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    kind: "human",
    username: "dan",
    displayName: "Dan",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  },
];

const response: CommunicationPathsResponse = {
  generatedAt: now,
  members,
  paths: [
    {
      memberAId: "10000000-0000-4000-8000-000000000001",
      memberBId: "10000000-0000-4000-8000-000000000002",
      directMessageCount: 4,
      sharedChannelCount: 2,
      channelMessageCount: 7,
      lastActivityAt: now,
    },
  ],
};

function clientWith(
  getCommunicationPaths: CommunicationPathsClient["getCommunicationPaths"],
): CommunicationPathsClient {
  return { getCommunicationPaths };
}

describe("CommunicationPathsView", () => {
  it("fetches paths when first active and renders one row per member pair", async () => {
    const getCommunicationPaths = vi.fn(async () => response);
    const { rerender } = render(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members: [],
        active: true,
      }),
    );

    expect(getCommunicationPaths).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("cell", { name: "Morgan" })).toBeTruthy());
    // Names resolve from the response snapshot, not the bootstrap member list.
    expect(screen.getByRole("cell", { name: "Dan" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "4" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "7" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "11" })).toBeTruthy();
    expect(document.querySelector('time[dateTime="2026-08-20T12:00:00.000Z"]')).not.toBeNull();

    rerender(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members: [],
        active: false,
      }),
    );
    rerender(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members: [],
        active: true,
      }),
    );
    expect(getCommunicationPaths).toHaveBeenCalledTimes(1);
  });

  it("does not fetch while inactive and stays out of the layout", () => {
    const getCommunicationPaths = vi.fn(async () => response);
    render(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members,
        active: false,
      }),
    );

    expect(getCommunicationPaths).not.toHaveBeenCalled();
    expect(screen.getByTestId("communication-paths-view").hidden).toBe(true);
  });

  it("refetches only when Refresh is pressed", async () => {
    const gates: Array<{ resolve: () => void }> = [];
    const getCommunicationPaths = vi.fn(
      () =>
        new Promise<CommunicationPathsResponse>((resolve) => {
          gates.push({ resolve: () => resolve(response) });
        }),
    );
    render(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members,
        active: true,
      }),
    );
    await waitFor(() => {
      if (gates[0] === undefined) throw new Error("not requested yet");
      gates[0].resolve();
    });
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());

    screen.getByRole("button", { name: "Refresh" }).click();
    await waitFor(() => expect(gates.length).toBe(2));
    // The cached table stays on screen with a busy signal while the refresh is in flight.
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
    gates[1]?.resolve();
    await waitFor(() => expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("false"));
    expect(getCommunicationPaths).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rejection without leaving a stale table", async () => {
    const getCommunicationPaths = vi.fn(async () => {
      throw new Error("Only workspace owners can view communication paths");
    });
    render(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members,
        active: true,
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Only workspace owners"),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an empty state when no member pair has communicated", async () => {
    const getCommunicationPaths = vi.fn(async () => ({ ...response, paths: [] }));
    render(
      createElement(CommunicationPathsView, {
        client: clientWith(getCommunicationPaths),
        members,
        active: true,
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "No communication yet" })).toBeTruthy(),
    );
  });
});
