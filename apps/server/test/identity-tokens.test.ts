import { createHash } from "node:crypto";

import {
  agentTokenSecretSchema,
  magicLinkTokenSchema,
  sessionTokenSchema,
} from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import { hashToken, issueAgentToken, issueToken } from "../src/modules/identity/tokens.js";

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

  it("issues prefixed 256-bit agent credentials and hashes the complete secret", () => {
    const issued = issueAgentToken();

    expect(agentTokenSecretSchema.parse(issued.token)).toBe(issued.token);
    expect(issued.hash).toEqual(hashToken(issued.token));
    expect(issued.hash).not.toEqual(hashToken(issued.token.slice("hmm_agent_".length)));
  });
});
