import {
  desktopAuthCallbackParametersSchema,
  magicLinkTokenSchema,
  type DesktopAuthCallbackParameters,
  type MagicLinkToken,
} from "@hmm-chat/contracts";

import { normalizeAuthCallbackUrl } from "./security";

export type AuthCallbackOutcome = "ignored" | "succeeded" | "failed";

export type ParsedAuthCallback =
  | { readonly kind: "magic_link"; readonly token: MagicLinkToken }
  | { readonly kind: "authkit"; readonly callback: DesktopAuthCallbackParameters };

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

export function parseAuthKitCallback(value: string): DesktopAuthCallbackParameters | null {
  const normalized = normalizeAuthCallbackUrl(value);
  if (normalized === null) {
    return null;
  }

  const url = new URL(normalized);
  if (url.port !== "" || url.hash !== "") {
    return null;
  }

  const parameters = [...url.searchParams.entries()];
  const parameterNames = parameters.map(([name]) => name);
  if (parameters.length !== 2 || new Set(parameterNames).size !== 2) {
    return null;
  }

  const parsed = desktopAuthCallbackParametersSchema.safeParse(Object.fromEntries(parameters));
  return parsed.success ? parsed.data : null;
}

export function parseAuthCallback(value: string): ParsedAuthCallback | null {
  const token = parseAuthCallbackToken(value);
  if (token !== null) {
    return { kind: "magic_link", token };
  }

  const callback = parseAuthKitCallback(value);
  return callback === null ? null : { kind: "authkit", callback };
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
