import { createHash, randomBytes } from "node:crypto";

export interface IssuedToken {
  readonly token: string;
  readonly hash: Buffer;
}

export function hashToken(token: string): Buffer {
  // These are 256-bit random credentials, not user-chosen passwords. There is nothing practical
  // to brute-force, so a slow password KDF would only add latency without improving security.
  return createHash("sha256").update(token, "utf8").digest();
}

export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function issueAgentToken(): IssuedToken {
  const token = `hype_comms_agent_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}
