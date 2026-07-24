import { describe, expect, it } from "vitest";

import { resolveSuggestedName, SuggestedNameError } from "./suggested-name";

describe("sign-in name suggestion", () => {
  it("reads both supported command-line forms", () => {
    expect(resolveSuggestedName(["electron", ".", "--name", "Morgan"], {})).toBe("Morgan");
    expect(resolveSuggestedName(["electron", ".", "--name=Alex"], {})).toBe("Alex");
  });

  it("uses the launcher's environment value when Electron receives no flag", () => {
    expect(resolveSuggestedName(["electron", "."], { HMM_CHAT_NAME: "  Morgan  " })).toBe("Morgan");
  });

  it("returns an empty suggestion when no name is supplied", () => {
    expect(resolveSuggestedName(["electron", "."], {})).toBe("");
    expect(resolveSuggestedName(["electron", "."], { HMM_CHAT_NAME: "   " })).toBe("");
  });

  it("rejects duplicate and unsafe names", () => {
    expect(() =>
      resolveSuggestedName(["electron", ".", "--name=Morgan", "--name=Alex"], {}),
    ).toThrow(SuggestedNameError);
    expect(() => resolveSuggestedName(["electron", ".", "--name", "A\nB"], {})).toThrow(
      SuggestedNameError,
    );
  });
});
