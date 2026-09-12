import { describe, expect, it } from "vitest";

import { parseInviteArguments } from "../src/modules/identity/invite-cli.js";

describe("invite CLI argument parsing", () => {
  it("normalizes an email and defaults the role", () => {
    expect(parseInviteArguments(["--email", "MEMBER@example.com"])).toEqual({
      email: "member@example.com",
      role: "member",
    });
  });

  it("does not accept an unauthenticated callback selector", () => {
    expect(() =>
      parseInviteArguments(["--email", "member@example.com", "--variant", "development"]),
    ).toThrow(/Unknown argument: --variant/u);
  });
});
