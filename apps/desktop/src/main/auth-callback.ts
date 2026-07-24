import { magicLinkTokenSchema, type MagicLinkToken } from "@hmm-chat/contracts";

import { normalizeAuthCallbackUrl } from "./security";

export type AuthCallbackOutcome = "ignored" | "succeeded" | "failed";

export function parseAuthCallbackToken(value: string): MagicLinkToken | null {
  const normalized = normalizeAuthCallbackUrl(value);
  if (normalized === null) {
    return null;
  }

  const tokens = new URL(normalized).searchParams.getAll("token");
  if (tokens.length !== 1) {
    return null;
  }

  const parsed = magicLinkTokenSchema.safeParse(tokens[0]);
  return parsed.success ? parsed.data : null;
}

export async function processAuthCallback(
  value: string,
  exchange: (token: MagicLinkToken) => Promise<void>,
): Promise<AuthCallbackOutcome> {
  const token = parseAuthCallbackToken(value);
  if (token === null) {
    return "ignored";
  }

  try {
    await exchange(token);
    return "succeeded";
  } catch {
    return "failed";
  }
}
