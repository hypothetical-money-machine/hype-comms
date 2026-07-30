import { z } from "zod";

import { emailSchema, type Email } from "@hmm-chat/contracts";

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
    metricsToken: optionalString(z.string().min(32).max(256)),
    allowedOrigins: optionalString(z.string().min(1)),
    publicApiUrl: optionalString(z.string().min(1)),
    webRoot: optionalString(z.string().min(1)),
    databaseUrl: optionalString(z.string().min(1)),
    databasePoolSize: z.coerce.number().int().min(1).max(100).default(10),
    smtpUrl: optionalString(z.url()),
    emailFrom: optionalString(z.string().min(1)),
    emailDelivery: z.enum(["smtp", "console", "manual"]).optional(),
    ownerEmail: optionalString(emailSchema),
    workspaceName: z.string().trim().min(1).max(120).default("HMM Chat"),
    workspaceSlug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .default("hmm-chat"),
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
  /** Enables the private Prometheus endpoint when configured. */
  readonly metricsToken?: string;
  readonly allowedOrigins: readonly string[];
  readonly publicApiUrl: string;
  /**
   * Session cookies carry `Secure` only when the public URL is HTTPS. Browsers silently discard
   * `Secure` cookies delivered over plain HTTP, which would make sign-in fail with no visible
   * error during loopback testing.
   */
  readonly cookieSecure: boolean;
  readonly webRoot?: string;
  /**
   * PostgreSQL backs identity and the M2 conversation core. Product features register only when
   * a database URL is configured.
   */
  readonly database?: {
    readonly url: string;
    readonly poolSize: number;
  };
  readonly smtp?: {
    readonly url: string;
    readonly from: string;
  };
  /**
   * How sign-in links reach people. `manual` means an administrator issues them with the invite
   * command and passes them along privately, which lets a real deployment run before an email
   * provider exists. Self-service link requests are refused in that mode rather than accepted and
   * silently dropped.
   */
  readonly emailDelivery: "smtp" | "console" | "manual";
  readonly owner?: {
    readonly email: Email;
    readonly workspaceName: string;
    readonly workspaceSlug: string;
  };
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
    metricsToken: env.HMM_METRICS_TOKEN,
    allowedOrigins: env.HMM_ALLOWED_ORIGINS,
    publicApiUrl: env.HMM_PUBLIC_API_URL,
    databaseUrl: env.HMM_DATABASE_URL,
    databasePoolSize: env.HMM_DATABASE_POOL_SIZE,
    smtpUrl: env.HMM_SMTP_URL,
    emailDelivery: env.HMM_EMAIL_DELIVERY,
    emailFrom: env.HMM_EMAIL_FROM,
    ownerEmail: env.HMM_OWNER_EMAIL,
    workspaceName: env.HMM_WORKSPACE_NAME,
    workspaceSlug: env.HMM_WORKSPACE_SLUG,
  });

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  if ((result.data.smtpUrl === undefined) !== (result.data.emailFrom === undefined)) {
    throw new ConfigError(["smtp: HMM_SMTP_URL and HMM_EMAIL_FROM must be configured together"]);
  }

  const hasSmtp = result.data.smtpUrl !== undefined && result.data.emailFrom !== undefined;
  const identityEnabled = result.data.databaseUrl !== undefined;
  const emailDelivery =
    result.data.emailDelivery ??
    (hasSmtp
      ? "smtp"
      : result.data.nodeEnv !== "production"
        ? "console"
        : identityEnabled
          ? undefined
          : "manual");
  if (emailDelivery === undefined) {
    throw new ConfigError([
      "emailDelivery: Configure HMM_SMTP_URL and HMM_EMAIL_FROM, or set " +
        "HMM_EMAIL_DELIVERY=manual to issue sign-in links with the invite command",
    ]);
  }
  if (emailDelivery === "smtp" && !hasSmtp) {
    throw new ConfigError(["emailDelivery: smtp requires HMM_SMTP_URL and HMM_EMAIL_FROM"]);
  }
  if (emailDelivery === "console" && result.data.nodeEnv === "production") {
    throw new ConfigError([
      "emailDelivery: console writes a live credential to the log and is not allowed in production",
    ]);
  }
  if (result.data.nodeEnv === "production" && result.data.databaseUrl === undefined) {
    throw new ConfigError(["databaseUrl: PostgreSQL is required in production"]);
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
      ? "https://chat-api.example.invalid"
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
    ...(result.data.metricsToken === undefined ? {} : { metricsToken: result.data.metricsToken }),
    allowedOrigins: [...new Set(originsResult.data)],
    publicApiUrl: publicApiResult.data,
    cookieSecure: parsedPublicApiUrl.protocol === "https:",
    ...(result.data.webRoot === undefined ? {} : { webRoot: result.data.webRoot }),
    ...(result.data.databaseUrl === undefined
      ? {}
      : { database: { url: result.data.databaseUrl, poolSize: result.data.databasePoolSize } }),
    ...(result.data.smtpUrl === undefined || result.data.emailFrom === undefined
      ? {}
      : { smtp: { url: result.data.smtpUrl, from: result.data.emailFrom } }),
    emailDelivery,
    ...(result.data.ownerEmail === undefined
      ? {}
      : {
          owner: {
            email: result.data.ownerEmail,
            workspaceName: result.data.workspaceName,
            workspaceSlug: result.data.workspaceSlug,
          },
        }),
  };
}
