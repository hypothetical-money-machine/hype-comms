export interface BearerAuthorization {
  readonly scheme: "bearer" | "other";
  readonly token: string | null;
}

/** Scheme names are case-insensitive; only spaces or tabs may separate the token. */
export function parseBearerAuthorization(
  value: string | string[] | undefined,
): BearerAuthorization {
  if (typeof value !== "string" || !/^Bearer(?:[ \t]|$)/i.test(value)) {
    return { scheme: "other", token: null };
  }
  // Keep a malformed Bearer header distinguishable from another scheme so it cannot fall back
  // to a cookie or escape the mixed-credential check. Token schemas validate the secret itself.
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(value);
  const token = match?.[0] === value ? (match[1] ?? null) : null;
  return { scheme: "bearer", token };
}
