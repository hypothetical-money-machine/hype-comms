import { describe, expect, it } from "vitest";

import {
  createInitialCompactModeArgument,
  parseInitialCompactModeArgument,
  resolveInitialCompactModeArgument,
} from "./compact-mode";

describe("compact mode startup argument", () => {
  it("round-trips an encoded true value", () => {
    const argument = createInitialCompactModeArgument(true);

    expect(argument).toBe("--hmm-chat-initial-compact-mode=true");
    expect(parseInitialCompactModeArgument([argument])).toBe(true);
    expect(resolveInitialCompactModeArgument([argument])).toBe(true);
  });

  it("round-trips an encoded false value", () => {
    const argument = createInitialCompactModeArgument(false);

    expect(argument).toBe("--hmm-chat-initial-compact-mode=false");
    expect(parseInitialCompactModeArgument([argument])).toBe(false);
    expect(resolveInitialCompactModeArgument([argument])).toBe(false);
  });

  it("resolves false when the argument is missing", () => {
    expect(parseInitialCompactModeArgument([])).toBeNull();
    expect(resolveInitialCompactModeArgument([])).toBe(false);
    expect(resolveInitialCompactModeArgument(["--renderer-process"])).toBe(false);
  });

  it("resolves false for malformed values", () => {
    for (const malformed of ["", "1", "TRUE", "yes"]) {
      const argument = `--hmm-chat-initial-compact-mode=${malformed}`;

      expect(parseInitialCompactModeArgument([argument])).toBeNull();
      expect(resolveInitialCompactModeArgument([argument])).toBe(false);
    }
  });

  it("uses the last matching argument when duplicates are present", () => {
    const argv = ["--hmm-chat-initial-compact-mode=true", "--hmm-chat-initial-compact-mode=false"];

    expect(parseInitialCompactModeArgument(argv)).toBe(false);
    expect(resolveInitialCompactModeArgument(argv)).toBe(false);
  });

  it("ignores unrelated arguments", () => {
    const argv = [
      "--renderer-process",
      "--hmm-chat-initial-theme-state=%7B%7D",
      "--hmm-chat-initial-compact-mode=true",
      "--some-other-flag",
    ];

    expect(parseInitialCompactModeArgument(argv)).toBe(true);
    expect(resolveInitialCompactModeArgument(argv)).toBe(true);
  });
});
