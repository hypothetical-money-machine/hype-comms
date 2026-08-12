import { isIP } from "node:net";

import { z } from "zod";

import { emailSchema, type Email } from "@hype-comms/contracts";

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
    agentProvisioningEnabled: z.enum(["true", "false"]).optional(),
    ownerEmail: optionalString(emailSchema),
    workspaceName: z.string().trim().min(1).max(120).default("Hype Comms"),
    workspaceSlug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .default("hmm-chat"),
    announcementChannelsEnabled: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    authKitAdmissionEnabled: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    workosApiKey: optionalString(z.string().min(1).max(512).startsWith("sk_")),
    workosClientId: optionalString(z.string().min(1).max(255).startsWith("client_")),
    workosRedirectUri: optionalString(z.string().min(1).max(2_048)),
    workosJwtIssuer: optionalString(z.string().min(1).max(2_048)),
    workosEncryptionKey: optionalString(
      z
        .string()
        .length(43)
        .regex(/^[A-Za-z0-9_-]+$/, "Expected an unpadded 32-byte base64url value"),
    ),
    workosWebhookSecret: optionalString(z.string().min(16).max(512)),
    trustedProxies: optionalString(z.string().min(1)),
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

const configuredJwtIssuerSchema = z
  .string()
  .min(1)
  .refine(
    (issuer) => {
      try {
        const url = new URL(issuer);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "" &&
          (issuer === url.origin || issuer === `${url.origin}/`)
        );
      } catch {
        return false;
      }
    },
    { message: "Expected an exact HTTPS issuer URL without credentials, query, or fragment" },
  );

const trustedProxySchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      const slash = value.indexOf("/");
      if (slash !== value.lastIndexOf("/")) return false;

      const address = slash === -1 ? value : value.slice(0, slash);
      const version = isIP(address);
      if (version === 0) return false;
      if (slash === -1) return true;

      const prefix = value.slice(slash + 1);
      if (!/^[1-9][0-9]*$/.test(prefix)) return false;
      return Number(prefix) <= (version === 4 ? 32 : 128);
    },
    {
      message:
        "Expected an IP address or CIDR with a nonzero numeric prefix, not a name or hop count",
    },
  );

export interface ServerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly shutdownTimeoutMs: number;
  /** Requests the one-way cluster cutover after every server and realtime worker is compatible. */
  readonly announcementChannelsEnabled: boolean;
  /**
   * Exposes AuthKit admission only after its provider, revocation, and proxy trust boundaries are
   * ready. Provider maintenance and signed webhooks may remain active while this is false.
   */
  readonly authKitAdmissionEnabled: boolean;
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
  /** Exact proxy addresses/CIDRs allowed to supply Fastify's forwarded client metadata. */
  readonly trustedProxies: readonly string[];
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
  /**
   * Agent rows use a user kind that the previous server release cannot parse. Production keeps
   * provisioning off by default until that release is outside the rollback window.
   */
  readonly agentProvisioningEnabled: boolean;
  readonly owner?: {
    readonly email: Email;
    readonly workspaceName: string;
    readonly workspaceSlug: string;
  };
  /** Server-only WorkOS AuthKit integration. No value in this object crosses into Electron. */
  readonly workos?: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly jwtIssuer: string;
    readonly encryptionKey: Buffer;
    readonly webhookSecret?: string;
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
    agentProvisioningEnabled: env.HMM_AGENT_PROVISIONING_ENABLED,
    emailFrom: env.HMM_EMAIL_FROM,
    ownerEmail: env.HMM_OWNER_EMAIL,
    workspaceName: env.HMM_WORKSPACE_NAME,
    workspaceSlug: env.HMM_WORKSPACE_SLUG,
    announcementChannelsEnabled: env.HMM_ANNOUNCEMENT_CHANNELS_ENABLED,
    authKitAdmissionEnabled: env.HMM_AUTHKIT_ADMISSION_ENABLED,
    workosApiKey: env.WORKOS_API_KEY,
    workosClientId: env.WORKOS_CLIENT_ID,
    workosRedirectUri: env.WORKOS_REDIRECT_URI,
    workosJwtIssuer: env.WORKOS_JWT_ISSUER,
    workosEncryptionKey: env.HMM_AUTH_ENCRYPTION_KEY,
    workosWebhookSecret: env.WORKOS_WEBHOOK_SECRET,
    trustedProxies: env.HMM_TRUSTED_PROXIES,
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

  const proxyCandidates =
    result.data.trustedProxies === undefined ? [] : result.data.trustedProxies.split(",");
  const trustedProxiesResult = z.array(trustedProxySchema).safeParse(proxyCandidates);
  if (!trustedProxiesResult.success) {
    throw new ConfigError(
      trustedProxiesResult.error.issues.map(
        (issue) => `trustedProxies.${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  const trustedProxies = [...new Set(trustedProxiesResult.data)];

  const workosValues = [
    result.data.workosApiKey,
    result.data.workosClientId,
    result.data.workosRedirectUri,
    result.data.workosEncryptionKey,
  ];
  const configuredWorkosValues = workosValues.filter((value) => value !== undefined);
  if (
    configuredWorkosValues.length !== 0 &&
    configuredWorkosValues.length !== workosValues.length
  ) {
    throw new ConfigError([
      "workos: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI, and " +
        "HMM_AUTH_ENCRYPTION_KEY must be configured together",
    ]);
  }
  if (result.data.workosWebhookSecret !== undefined && configuredWorkosValues.length === 0) {
    throw new ConfigError([
      "workosWebhookSecret: the WorkOS provider settings are required when " +
        "WORKOS_WEBHOOK_SECRET is configured",
    ]);
  }
  if (result.data.workosJwtIssuer !== undefined && configuredWorkosValues.length === 0) {
    throw new ConfigError([
      "workosJwtIssuer: the WorkOS provider settings are required when " +
        "WORKOS_JWT_ISSUER is configured",
    ]);
  }
  if (configuredWorkosValues.length > 0 && result.data.databaseUrl === undefined) {
    throw new ConfigError(["workos: HMM_DATABASE_URL is required for AuthKit"]);
  }
  if (result.data.authKitAdmissionEnabled && configuredWorkosValues.length === 0) {
    throw new ConfigError([
      "authKitAdmissionEnabled: WorkOS provider settings are required when " +
        "HMM_AUTHKIT_ADMISSION_ENABLED=true",
    ]);
  }

  let workos: ServerConfig["workos"];
  if (
    result.data.workosApiKey !== undefined &&
    result.data.workosClientId !== undefined &&
    result.data.workosRedirectUri !== undefined &&
    result.data.workosEncryptionKey !== undefined
  ) {
    const expectedKeyPrefix = result.data.nodeEnv === "production" ? "sk_live_" : "sk_test_";
    if (!result.data.workosApiKey.startsWith(expectedKeyPrefix)) {
      throw new ConfigError([
        `workosApiKey: ${result.data.nodeEnv} requires a ${expectedKeyPrefix} API key`,
      ]);
    }

    let redirectUri: URL;
    try {
      redirectUri = new URL(result.data.workosRedirectUri);
    } catch {
      throw new ConfigError(["workosRedirectUri: Expected a valid URL"]);
    }
    if (
      redirectUri.username !== "" ||
      redirectUri.password !== "" ||
      redirectUri.search !== "" ||
      redirectUri.hash !== "" ||
      redirectUri.pathname !== "/v1/auth/workos/callback"
    ) {
      throw new ConfigError([
        "workosRedirectUri: Expected the credential-free /v1/auth/workos/callback URL",
      ]);
    }
    if (redirectUri.origin !== publicApiResult.data) {
      throw new ConfigError(["workosRedirectUri: Expected the configured public API origin"]);
    }

    const jwtIssuer = result.data.workosJwtIssuer ?? "https://api.workos.com/";
    const jwtIssuerResult = configuredJwtIssuerSchema.safeParse(jwtIssuer);
    if (!jwtIssuerResult.success) {
      throw new ConfigError([
        "workosJwtIssuer: Expected an exact HTTPS issuer URL without credentials, path, query, or fragment",
      ]);
    }

    const encryptionKey = Buffer.from(result.data.workosEncryptionKey, "base64url");
    if (encryptionKey.byteLength !== 32) {
      throw new ConfigError(["workosEncryptionKey: Expected exactly 32 decoded bytes"]);
    }
    if (
      result.data.nodeEnv === "production" &&
      result.data.authKitAdmissionEnabled &&
      result.data.workosWebhookSecret === undefined
    ) {
      throw new ConfigError([
        "workosWebhookSecret: WORKOS_WEBHOOK_SECRET is required to enable production AuthKit",
      ]);
    }
    if (
      result.data.nodeEnv === "production" &&
      result.data.authKitAdmissionEnabled &&
      trustedProxies.length === 0
    ) {
      throw new ConfigError([
        "trustedProxies: HMM_TRUSTED_PROXIES must name the reverse proxy IP/CIDR for " +
          "enabled production AuthKit",
      ]);
    }
    workos = {
      apiKey: result.data.workosApiKey,
      clientId: result.data.workosClientId,
      redirectUri: redirectUri.href,
      jwtIssuer: jwtIssuerResult.data,
      encryptionKey,
      ...(result.data.workosWebhookSecret === undefined
        ? {}
        : { webhookSecret: result.data.workosWebhookSecret }),
    };
  }

  return {
    nodeEnv: result.data.nodeEnv,
    host: result.data.host,
    port: result.data.port,
    logLevel: result.data.logLevel,
    shutdownTimeoutMs: result.data.shutdownTimeoutMs,
    announcementChannelsEnabled: result.data.announcementChannelsEnabled,
    authKitAdmissionEnabled: result.data.authKitAdmissionEnabled,
    ...(result.data.metricsToken === undefined ? {} : { metricsToken: result.data.metricsToken }),
    allowedOrigins: [...new Set(originsResult.data)],
    publicApiUrl: publicApiResult.data,
    cookieSecure: parsedPublicApiUrl.protocol === "https:",
    trustedProxies,
    ...(result.data.webRoot === undefined ? {} : { webRoot: result.data.webRoot }),
    ...(result.data.databaseUrl === undefined
      ? {}
      : { database: { url: result.data.databaseUrl, poolSize: result.data.databasePoolSize } }),
    ...(result.data.smtpUrl === undefined || result.data.emailFrom === undefined
      ? {}
      : { smtp: { url: result.data.smtpUrl, from: result.data.emailFrom } }),
    emailDelivery,
    agentProvisioningEnabled:
      result.data.agentProvisioningEnabled === undefined
        ? result.data.nodeEnv !== "production"
        : result.data.agentProvisioningEnabled === "true",
    ...(result.data.ownerEmail === undefined
      ? {}
      : {
          owner: {
            email: result.data.ownerEmail,
            workspaceName: result.data.workspaceName,
            workspaceSlug: result.data.workspaceSlug,
          },
        }),
    ...(workos === undefined ? {} : { workos }),
  };
}
