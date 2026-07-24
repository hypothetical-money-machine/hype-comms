import { z } from "zod";

const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const rawConfigSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65_535).default(3_000),
    logLevel: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    shutdownTimeoutMs: z.coerce.number().int().min(100).max(60_000).default(10_000),
    allowedOrigins: optionalString(z.string().min(1)),
    publicApiUrl: optionalString(z.string().min(1)),
    chatEnabled: z.enum(["true", "false"]).default("false"),
    chatAccessCode: optionalString(z.string().min(16)),
    chatDataPath: z.string().min(1).default("/data/hmm-chat.sqlite"),
    webRoot: optionalString(z.string().min(1)),
  })
  .strict();

const configuredOriginSchema = z
  .string()
  .min(1)
  .refine(
    (origin) => {
      try {
        const url = new URL(origin);
        if (url.username === "" && url.password === "" && url.search === "" && url.hash === "") {
          if (url.protocol === "http:" || url.protocol === "https:") {
            return origin === url.origin;
          }
          return url.pathname === "";
        }
        return false;
      } catch {
        return false;
      }
    },
    { message: "Expected an origin without credentials, path, query, or fragment" },
  );

export interface ServerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly shutdownTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
  readonly publicApiUrl: string;
  readonly chat: {
    readonly enabled: boolean;
    readonly accessCode?: string;
    readonly dataPath: string;
    /**
     * Session cookies carry `Secure` only when the public URL is HTTPS. Browsers silently discard
     * `Secure` cookies delivered over plain HTTP, which would make sign-in fail with no visible
     * error during loopback testing.
     */
    readonly cookieSecure: boolean;
  };
  readonly webRoot?: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid server configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const result = rawConfigSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    host: env.HMM_HOST,
    port: env.HMM_PORT,
    logLevel: env.HMM_LOG_LEVEL,
    shutdownTimeoutMs: env.HMM_SHUTDOWN_TIMEOUT_MS,
    allowedOrigins: env.HMM_ALLOWED_ORIGINS,
    publicApiUrl: env.HMM_PUBLIC_API_URL,
    chatEnabled: env.HMM_CHAT_ENABLED,
    chatAccessCode: env.HMM_CHAT_ACCESS_CODE,
    chatDataPath: env.HMM_CHAT_DATA_PATH,
  });

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  if (result.data.chatEnabled === "true" && result.data.chatAccessCode === undefined) {
    throw new ConfigError(["chatAccessCode: Required when chat is enabled"]);
  }

  const defaultOrigins =
    result.data.nodeEnv === "production" ? ["app://bundle"] : ["http://127.0.0.1:5173"];
  const candidateOrigins = result.data.allowedOrigins
    ? result.data.allowedOrigins.split(",").map((origin) => origin.trim())
    : defaultOrigins;
  const originsResult = z.array(configuredOriginSchema).min(1).safeParse(candidateOrigins);

  if (!originsResult.success) {
    throw new ConfigError(
      originsResult.error.issues.map(
        (issue) => `allowedOrigins.${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }

  const publicApiUrl =
    result.data.publicApiUrl ??
    (result.data.nodeEnv === "production"
      ? "https://api.chat.hypemm.com"
      : `http://127.0.0.1:${result.data.port}`);
  const publicApiResult = configuredOriginSchema.safeParse(publicApiUrl);

  if (!publicApiResult.success) {
    throw new ConfigError([`publicApiUrl: ${publicApiResult.error.issues[0]?.message}`]);
  }

  const parsedPublicApiUrl = new URL(publicApiResult.data);
  if (result.data.nodeEnv === "production" && parsedPublicApiUrl.protocol !== "https:") {
    throw new ConfigError(["publicApiUrl: HTTPS is required in production"]);
  }
  if (
    result.data.nodeEnv !== "production" &&
    (parsedPublicApiUrl.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsedPublicApiUrl.hostname))
  ) {
    throw new ConfigError(["publicApiUrl: development and test URLs must use loopback HTTP"]);
  }

  return {
    nodeEnv: result.data.nodeEnv,
    host: result.data.host,
    port: result.data.port,
    logLevel: result.data.logLevel,
    shutdownTimeoutMs: result.data.shutdownTimeoutMs,
    allowedOrigins: [...new Set(originsResult.data)],
    publicApiUrl: publicApiResult.data,
    chat: {
      enabled: result.data.chatEnabled === "true",
      ...(result.data.chatAccessCode === undefined
        ? {}
        : { accessCode: result.data.chatAccessCode }),
      dataPath: result.data.chatDataPath,
      cookieSecure: parsedPublicApiUrl.protocol === "https:",
    },
    ...(result.data.webRoot === undefined ? {} : { webRoot: result.data.webRoot }),
  };
}
