import { describe, expect, it } from "vitest";

import { parseOwnerCommand } from "../src/modules/identity/owner-cli.js";

describe("owner CLI argument parsing", () => {
  it("accepts one normalized email target", () => {
    expect(parseOwnerCommand(["promote", "MEMBER@example.com"])).toEqual({
      name: "promote",
      target: { type: "email", value: "member@example.com" },
    });
  });

  it("rejects flags and extra targets", () => {
    expect(() => parseOwnerCommand(["demote", "--email"])).toThrow(
      /A username or email is required/u,
    );
    expect(() => parseOwnerCommand(["promote", "one", "two"])).toThrow(
      /Only one username or email/u,
    );
  });
});
