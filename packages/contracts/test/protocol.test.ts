import { describe, expect, it } from "vitest";
import { isWorkspaceProtocolMismatch } from "../src/protocol.js";

describe("workspace protocol mismatch", () => {
  it.each([
    [426, "2", true],
    [200, "1", true],
    [200, "3", true],
    [200, null, true],
    [404, null, true],
    [404, "2", false],
    [200, "2", false],
    [401, "2", false],
    [429, null, false],
    [502, null, false],
    [503, "2", false],
  ] as const)("classifies HTTP %s with protocol %s", (status, major, mismatch) => {
    const headers = new Headers(major === null ? {} : { "x-hype-comms-protocol": major });
    expect(isWorkspaceProtocolMismatch({ status, headers })).toBe(mismatch);
  });
});
