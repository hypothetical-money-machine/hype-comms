import {
  desktopAuthCallbackParametersSchema,
  magicLinkTokenSchema,
  type DesktopAuthCallbackParameters,
  type MagicLinkToken,
} from "@hype-comms/contracts";

import { normalizeAuthCallbackUrl, type AuthProtocolScheme } from "./security";

export type AuthCallbackOutcome = "ignored" | "succeeded" | "failed";

export type ParsedAuthCallback =
  | { readonly kind: "magic_link"; readonly token: MagicLinkToken }
  | { readonly kind: "authkit"; readonly callback: DesktopAuthCallbackParameters };

export function parseAuthCallbackToken(
  value: string,
  scheme: AuthProtocolScheme,
): MagicLinkToken | null {
  const normalized = normalizeAuthCallbackUrl(value, scheme);
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

export function parseAuthKitCallback(
  value: string,
  scheme: AuthProtocolScheme,
): DesktopAuthCallbackParameters | null {
  const normalized = normalizeAuthCallbackUrl(value, scheme);
  if (normalized === null) {
    return null;
  }

  const url = new URL(normalized);
  if (url.port !== "" || url.hash !== "") {
    return null;
  }

  const parameters = [...url.searchParams.entries()];
  const parameterNames = parameters.map(([name]) => name);
  if (
    parameters.length < 1 ||
    parameters.length > 2 ||
    new Set(parameterNames).size !== parameters.length
  ) {
    return null;
  }

  const parsed = desktopAuthCallbackParametersSchema.safeParse(Object.fromEntries(parameters));
  return parsed.success ? parsed.data : null;
}

export function parseAuthCallback(
  value: string,
  scheme: AuthProtocolScheme,
): ParsedAuthCallback | null {
  const token = parseAuthCallbackToken(value, scheme);
  if (token !== null) {
    return { kind: "magic_link", token };
  }

  const callback = parseAuthKitCallback(value, scheme);
  return callback === null ? null : { kind: "authkit", callback };
}

export async function processAuthCallback(
  value: string,
  scheme: AuthProtocolScheme,
  exchange: (token: MagicLinkToken) => Promise<void>,
): Promise<AuthCallbackOutcome> {
  const token = parseAuthCallbackToken(value, scheme);
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
