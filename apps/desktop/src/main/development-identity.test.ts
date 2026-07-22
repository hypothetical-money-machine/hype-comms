import { describe, expect, it } from "vitest";

import { DevelopmentIdentityError, resolveDevelopmentIdentity } from "./development-identity";

describe("temporary development identity", () => {
  it("reads both supported command-line forms", () => {
    expect(resolveDevelopmentIdentity(["electron", ".", "--name", "Morgan"], {})).toEqual({
      name: "Morgan",
    });
    expect(resolveDevelopmentIdentity(["electron", ".", "--name=Alex"], {})).toEqual({
      name: "Alex",
    });
  });

  it("uses the launcher's environment value when Electron receives no flag", () => {
    expect(resolveDevelopmentIdentity(["electron", "."], { HMM_CHAT_NAME: "  Morgan  " })).toEqual({
      name: "Morgan",
    });
  });

  it("rejects missing, duplicate, and unsafe names", () => {
    expect(() => resolveDevelopmentIdentity(["electron", "."], {})).toThrow(
      DevelopmentIdentityError,
    );
    expect(() =>
      resolveDevelopmentIdentity(["electron", ".", "--name=Morgan", "--name=Alex"], {}),
    ).toThrow(DevelopmentIdentityError);
    expect(() => resolveDevelopmentIdentity(["electron", ".", "--name", "A\nB"], {})).toThrow(
      DevelopmentIdentityError,
    );
  });
});
