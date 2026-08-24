// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import type { User } from "@hype-comms/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PresenceIndicator, typingIndicatorText } from "./activity-indicators";

const NOW = "2026-08-23T12:00:00.000Z";
const members: User[] = ["Morgan", "Alex", "Dan", "Sam", "Taylor"].map((displayName, index) => ({
  id: `10000000-0000-4000-8000-00000000000${String(index + 1)}`,
  kind: "human",
  username: displayName.toLowerCase(),
  displayName,
  avatarUrl: null,
  title: null,
  createdAt: NOW,
  updatedAt: NOW,
}));

afterEach(cleanup);

describe("activity indicators", () => {
  it.each(["online", "away", "offline"] as const)(
    "labels %s presence without a timestamp",
    (state) => {
      render(<PresenceIndicator state={state} />);
      const indicator = screen.getByLabelText(`Presence: ${state}`);

      expect(indicator.classList.contains(`presence-${state}`)).toBe(true);
      expect(indicator.getAttribute("title")).toBe(
        state.slice(0, 1).toUpperCase() + state.slice(1),
      );
      expect(indicator.getAttribute("title")).not.toMatch(/\d/u);
    },
  );

  it("phrases one and several typists and excludes the current user", () => {
    const ids = members.map((member) => member.id);

    expect(typingIndicatorText([ids[0]!, ids[1]!], members, ids[0]!)).toBe("Alex is typing…");
    expect(typingIndicatorText(ids.slice(1, 3), members, ids[0]!)).toBe("Alex and Dan are typing…");
    expect(typingIndicatorText(ids.slice(1), members, ids[0]!)).toBe(
      "Alex, Dan, and 2 others are typing…",
    );
  });
});
