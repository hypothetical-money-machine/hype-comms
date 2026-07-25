import { describe, expect, it } from "vitest";

import { resolveDevelopmentProfile } from "./development-profile";

describe("resolveDevelopmentProfile", () => {
  it("accepts an optional lowercase slug", () => {
    expect(resolveDevelopmentProfile({})).toBe("");
    expect(resolveDevelopmentProfile({ HMM_DESKTOP_PROFILE: "dan-laptop" })).toBe("dan-laptop");
  });

  it("rejects values that could escape or alias the profile directory", () => {
    expect(() => resolveDevelopmentProfile({ HMM_DESKTOP_PROFILE: "../other" })).toThrow();
    expect(() => resolveDevelopmentProfile({ HMM_DESKTOP_PROFILE: "Morgan" })).toThrow();
  });
});
