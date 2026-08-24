import { z } from "zod";

const MAX_API_ORIGIN_BYTES = 2_048;
const MAX_ENVIRONMENT_VALUE_BYTES = 4_096;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
]);

/** Returns a credential-free canonical HTTPS origin, or loopback HTTP for local development. */
export function normalizeAgentWakeApiOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_API_ORIGIN_BYTES ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const loopback =
    hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.origin;
}

export const agentWakeApiOriginSchema = z.string().superRefine((value, context) => {
  if (normalizeAgentWakeApiOrigin(value) !== value) {
    context.addIssue({ code: "custom", message: "Expected a canonical secure API origin" });
  }
});

/** Builds a bounded allowlisted child environment without inheriting runtime injection knobs. */
export function agentWakeProcessEnvironment(input: {
  readonly source: NodeJS.ProcessEnv;
  readonly fixed: Readonly<Record<string, string>>;
  readonly additionalAllowedKeys?: readonly string[];
}): NodeJS.ProcessEnv {
  const allowed = new Set(SAFE_ENVIRONMENT_KEYS);
  for (const key of input.additionalAllowedKeys ?? []) allowed.add(key.toUpperCase());
  const environment: NodeJS.ProcessEnv = { ...input.fixed };
  for (const [key, value] of Object.entries(input.source)) {
    if (
      value !== undefined &&
      allowed.has(key.toUpperCase()) &&
      Buffer.byteLength(value, "utf8") <= MAX_ENVIRONMENT_VALUE_BYTES &&
      !value.includes("\0")
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

/** Clamps an optional tuning knob to a positive safe integer, falling back and capping as given. */
export function agentWakePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number = Number.MAX_SAFE_INTEGER,
): number {
  const resolved =
    value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return Math.min(resolved, maximum);
}

/** Exponential backoff bounded by `maximumMs`, with the exponent capped to keep the math finite. */
export function agentWakeBackoffDelay(baseMs: number, maximumMs: number, attempt: number): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.min(20, Math.max(0, attempt - 1)));
}

/** True for a bounded handle free of control and format characters, such as a provider receipt. */
export function isAgentWakeOpaqueHandle(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/** True for a lowercase SHA-256 digest, the shape shared by wake ids and executable pins. */
export function isAgentWakeSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export const agentWakeSha256Schema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);
