import { describe, expect, it } from "vitest";

import {
  agentWakeApiOriginSchema,
  agentWakeProcessEnvironment,
  normalizeAgentWakeApiOrigin,
} from "./agent-wake-validation";

describe("agent wake validation", () => {
  it.each([
    ["https://chat.example.test", "https://chat.example.test"],
    ["https://chat.example.test/", "https://chat.example.test"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("normalizes an allowed API origin %s", (value, expected) => {
    expect(normalizeAgentWakeApiOrigin(value)).toBe(expected);
  });

  it.each([
    "http://internal.example.test",
    "https://user:password@chat.example.test",
    "https://chat.example.test/path",
    "https://chat.example.test?token=secret",
    "not-an-origin",
  ])("rejects an unsafe API origin %s", (value) => {
    expect(normalizeAgentWakeApiOrigin(value)).toBeNull();
    expect(agentWakeApiOriginSchema.safeParse(value).success).toBe(false);
  });

  it("requires persisted origins to be canonical", () => {
    expect(agentWakeApiOriginSchema.safeParse("https://chat.example.test").success).toBe(true);
    expect(agentWakeApiOriginSchema.safeParse("https://chat.example.test/").success).toBe(false);
  });

  it("shares bounded environment allowlisting across child adapters", () => {
    expect(
      agentWakeProcessEnvironment({
        source: {
          HOME: "/Users/tester",
          LANG: "x".repeat(4_097),
          TMPDIR: "bad\0value",
          HYPE_COMMS_CONFIG_DIR: "/Users/tester/.config/hype-comms",
          NODE_OPTIONS: "--require=/tmp/untrusted.js",
        },
        fixed: { NO_COLOR: "1" },
        additionalAllowedKeys: ["HYPE_COMMS_CONFIG_DIR"],
      }),
    ).toEqual({
      NO_COLOR: "1",
      HOME: "/Users/tester",
      HYPE_COMMS_CONFIG_DIR: "/Users/tester/.config/hype-comms",
    });
  });
});
