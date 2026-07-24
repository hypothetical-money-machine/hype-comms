import { createHash } from "node:crypto";

import { magicLinkTokenSchema, sessionTokenSchema } from "@hmm-chat/contracts";
import { describe, expect, it } from "vitest";

import { hashToken, issueToken } from "../src/modules/identity/tokens.js";

describe("identity tokens", () => {
  it("issues 32-byte base64url credentials and stores only their SHA-256 hashes", () => {
    const first = issueToken();
    const second = issueToken();

    expect(first.token).toHaveLength(43);
    expect(magicLinkTokenSchema.parse(first.token)).toBe(first.token);
    expect(sessionTokenSchema.parse(first.token)).toBe(first.token);
    expect(first.hash).toHaveLength(32);
    expect(first.hash).toEqual(createHash("sha256").update(first.token, "utf8").digest());
    expect(second.token).not.toBe(first.token);
  });

  it("hashes the token's UTF-8 bytes deterministically", () => {
    expect(hashToken("credential")).toEqual(
      Buffer.from("e265b6f564601a1fe8dc42785cd18a868bd8013eb5899560e79248767a683e6b", "hex"),
    );
  });
});
