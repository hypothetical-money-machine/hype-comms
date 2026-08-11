import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      allowedOrigins: ["http://127.0.0.1:5173"],
      publicApiUrl: "http://127.0.0.1:3000",
      cookieSecure: false,
      trustedProxies: [],
      agentProvisioningEnabled: true,
      authKitAdmissionEnabled: false,
    });
  });

  it("uses the production API and packaged renderer origins in production", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HMM_DATABASE_URL: "postgres://hmm:secret@postgres/hmm_chat",
        HMM_EMAIL_DELIVERY: "manual",
      }),
    ).toMatchObject({
      allowedOrigins: ["app://bundle"],
      publicApiUrl: "https://chat-api.example.invalid",
      cookieSecure: true,
      agentProvisioningEnabled: false,
    });
  });

  it("allows production to explicitly enable agent provisioning", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HMM_DATABASE_URL: "postgres://hmm:secret@postgres/hmm_chat",
        HMM_EMAIL_DELIVERY: "manual",
        HMM_AGENT_PROVISIONING_ENABLED: "true",
      }),
    ).toMatchObject({ agentProvisioningEnabled: true });
    expect(() => loadConfig({ HMM_AGENT_PROVISIONING_ENABLED: "yes" })).toThrow(ConfigError);
  });

  it("rejects malformed ports and origins", () => {
    expect(() => loadConfig({ HMM_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ HMM_ALLOWED_ORIGINS: "https://chat.example/path" })).toThrow(
      ConfigError,
    );
  });

  it("accepts only explicit proxy IP addresses and CIDRs", () => {
    expect(
      loadConfig({
        HMM_TRUSTED_PROXIES: " 172.16.0.0/12,127.0.0.1,fd00::/8,172.16.0.0/12 ",
      }),
    ).toMatchObject({
      trustedProxies: ["172.16.0.0/12", "127.0.0.1", "fd00::/8"],
    });

    for (const trustedProxies of [
      "true",
      "1",
      "loopback",
      "0.0.0.0/0",
      "10.0.0.0/33",
      "fd00::/129",
      "10.0.0.0/not-a-prefix",
      "10.0.0.0/8,,127.0.0.1",
    ]) {
      expect(() => loadConfig({ HMM_TRUSTED_PROXIES: trustedProxies })).toThrow(ConfigError);
    }
  });

  it("requires an unguessable metrics token", () => {
    expect(() => loadConfig({ HMM_METRICS_TOKEN: "too-short" })).toThrow(ConfigError);
    expect(loadConfig({ HMM_METRICS_TOKEN: "m".repeat(32) })).toMatchObject({
      metricsToken: "m".repeat(32),
    });
  });

  it("requires a safe, environment-appropriate public API origin", () => {
    expect(() =>
      loadConfig({ HMM_PUBLIC_API_URL: "http://example.com/path?secret=value" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ NODE_ENV: "production", HMM_PUBLIC_API_URL: "http://api.example.com" }),
    ).toThrow(ConfigError);
  });

  it("requires PostgreSQL in production and exposes its bounded pool configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(
      loadConfig({
        NODE_ENV: "production",
        HMM_DATABASE_URL: "postgres://hmm:secret@postgres/hmm_chat",
        HMM_DATABASE_POOL_SIZE: "7",
        HMM_EMAIL_DELIVERY: "manual",
      }),
    ).toMatchObject({
      database: {
        url: "postgres://hmm:secret@postgres/hmm_chat",
        poolSize: 7,
      },
    });
  });

  it("loads SMTP and owner seed settings only when configured", () => {
    expect(
      loadConfig({
        HMM_SMTP_URL: "smtp://mail.example.com:2525",
        HMM_EMAIL_FROM: "Hype Comms <chat@example.com>",
        HMM_OWNER_EMAIL: "OWNER@EXAMPLE.COM",
        HMM_WORKSPACE_NAME: "Pilot",
        HMM_WORKSPACE_SLUG: "pilot",
      }),
    ).toMatchObject({
      smtp: {
        url: "smtp://mail.example.com:2525",
        from: "Hype Comms <chat@example.com>",
      },
      owner: {
        email: "owner@example.com",
        workspaceName: "Pilot",
        workspaceSlug: "pilot",
      },
    });
  });

  it("requires SMTP URL and sender address together", () => {
    expect(() => loadConfig({ HMM_SMTP_URL: "smtp://mail.example.com:2525" })).toThrow(ConfigError);
    expect(() => loadConfig({ HMM_EMAIL_FROM: "chat@example.com" })).toThrow(ConfigError);
  });

  it("loads an all-or-none staging AuthKit configuration", () => {
    expect(
      loadConfig({
        HMM_DATABASE_URL: "postgres://hmm:secret@127.0.0.1/hmm_chat",
        WORKOS_API_KEY: "sk_test_example",
        WORKOS_CLIENT_ID: "client_example",
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback",
        HMM_AUTH_ENCRYPTION_KEY: "A".repeat(43),
      }),
    ).toMatchObject({
      authKitAdmissionEnabled: false,
      workos: {
        apiKey: "sk_test_example",
        clientId: "client_example",
        redirectUri: "http://127.0.0.1:3000/v1/auth/workos/callback",
        jwtIssuer: "https://api.workos.com",
        encryptionKey: Buffer.alloc(32),
      },
    });

    expect(() => loadConfig({ WORKOS_API_KEY: "sk_test_example" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        WORKOS_API_KEY: "sk_live_example",
        WORKOS_CLIENT_ID: "client_example",
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback",
        HMM_AUTH_ENCRYPTION_KEY: "A".repeat(43),
      }),
    ).toThrow(ConfigError);

    expect(() => loadConfig({ HMM_AUTHKIT_ADMISSION_ENABLED: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ HMM_AUTHKIT_ADMISSION_ENABLED: "true" })).toThrow(
      /WorkOS provider settings/,
    );
  });

  it("binds the AuthKit callback to the configured public origin", () => {
    const base = {
      HMM_DATABASE_URL: "postgres://hmm:secret@127.0.0.1/hmm_chat",
      WORKOS_API_KEY: "sk_test_example",
      WORKOS_CLIENT_ID: "client_example",
      HMM_AUTH_ENCRYPTION_KEY: "A".repeat(43),
    };
    expect(() =>
      loadConfig({
        ...base,
        WORKOS_REDIRECT_URI: "https://other.example/v1/auth/workos/callback",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...base,
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback?token=nope",
      }),
    ).toThrow(ConfigError);
  });

  it("pins AuthKit JWTs to a configurable HTTPS origin", () => {
    const base = {
      HMM_DATABASE_URL: "postgres://hmm:secret@127.0.0.1/hmm_chat",
      WORKOS_API_KEY: "sk_test_example",
      WORKOS_CLIENT_ID: "client_example",
      WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback",
      HMM_AUTH_ENCRYPTION_KEY: "A".repeat(43),
    };
    expect(loadConfig({ ...base, WORKOS_JWT_ISSUER: "https://auth.example.com" })).toMatchObject({
      workos: { jwtIssuer: "https://auth.example.com" },
    });

    for (const issuer of [
      "http://auth.example.com",
      "https://auth.example.com/",
      "https://auth.example.com/path",
      "https://user:secret@auth.example.com",
      "https://auth.example.com?tenant=other",
    ]) {
      expect(() => loadConfig({ ...base, WORKOS_JWT_ISSUER: issuer })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ WORKOS_JWT_ISSUER: "https://auth.example.com" })).toThrow(
      ConfigError,
    );
  });

  it("stages production WorkOS configuration while admission remains fail-closed", () => {
    const environment = {
      NODE_ENV: "production",
      HMM_DATABASE_URL: "postgres://hmm:secret@postgres/hmm_chat",
      HMM_EMAIL_DELIVERY: "manual",
      WORKOS_API_KEY: "sk_live_example",
      WORKOS_CLIENT_ID: "client_example",
      WORKOS_REDIRECT_URI: "https://chat-api.example.invalid/v1/auth/workos/callback",
      HMM_AUTH_ENCRYPTION_KEY: "A".repeat(43),
    };
    expect(loadConfig(environment)).toMatchObject({
      authKitAdmissionEnabled: false,
      trustedProxies: [],
      workos: { clientId: "client_example" },
    });

    expect(() => loadConfig({ ...environment, HMM_AUTHKIT_ADMISSION_ENABLED: "true" })).toThrow(
      /WORKOS_WEBHOOK_SECRET/,
    );
    expect(
      loadConfig({
        ...environment,
        HMM_AUTHKIT_ADMISSION_ENABLED: "true",
        WORKOS_WEBHOOK_SECRET: "whsec_example_secret",
        HMM_TRUSTED_PROXIES: "172.16.0.0/12",
      }),
    ).toMatchObject({
      authKitAdmissionEnabled: true,
      workos: { webhookSecret: "whsec_example_secret" },
      trustedProxies: ["172.16.0.0/12"],
    });

    expect(() =>
      loadConfig({
        ...environment,
        HMM_AUTHKIT_ADMISSION_ENABLED: "true",
        WORKOS_WEBHOOK_SECRET: "whsec_example_secret",
      }),
    ).toThrow(/HMM_TRUSTED_PROXIES/);
  });
});
