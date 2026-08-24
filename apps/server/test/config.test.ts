import { describe, expect, it, vi } from "vitest";

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
      defaultAgentAgencyEnabled: true,
      authKitAdmissionEnabled: false,
    });
  });

  it("uses the production API and packaged renderer origins in production", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@postgres/hype_comms",
        HYPE_COMMS_EMAIL_DELIVERY: "manual",
      }),
    ).toMatchObject({
      allowedOrigins: ["app://bundle"],
      publicApiUrl: "https://chat-api.example.invalid",
      cookieSecure: true,
      trustedProxies: ["127.0.0.1", "::1"],
      agentProvisioningEnabled: false,
      defaultAgentAgencyEnabled: false,
    });
  });

  it("allows production to explicitly enable agent provisioning", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@postgres/hype_comms",
        HYPE_COMMS_EMAIL_DELIVERY: "manual",
        HYPE_COMMS_AGENT_PROVISIONING_ENABLED: "true",
      }),
    ).toMatchObject({ agentProvisioningEnabled: true });
    expect(() => loadConfig({ HYPE_COMMS_AGENT_PROVISIONING_ENABLED: "yes" })).toThrow(ConfigError);
  });

  it("requires an explicit production cutover for default agent agency", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@postgres/hype_comms",
        HYPE_COMMS_EMAIL_DELIVERY: "manual",
        HYPE_COMMS_DEFAULT_AGENT_AGENCY_ENABLED: "true",
      }),
    ).toMatchObject({ defaultAgentAgencyEnabled: true });
    expect(() => loadConfig({ HYPE_COMMS_DEFAULT_AGENT_AGENCY_ENABLED: "yes" })).toThrow(
      ConfigError,
    );
  });

  it("maps HYPE_COMMS_WEB_ROOT to webRoot and omits it when unset", () => {
    expect(loadConfig({ HYPE_COMMS_WEB_ROOT: "/srv/hype-comms/web" })).toMatchObject({
      webRoot: "/srv/hype-comms/web",
    });
    expect(loadConfig({})).not.toHaveProperty("webRoot");
  });

  it("rejects malformed ports and origins", () => {
    expect(() => loadConfig({ HYPE_COMMS_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ HYPE_COMMS_ALLOWED_ORIGINS: "https://chat.example/path" })).toThrow(
      ConfigError,
    );
  });

  it("accepts only explicit proxy IP addresses and CIDRs", () => {
    expect(
      loadConfig({
        HYPE_COMMS_TRUSTED_PROXIES: " 172.16.0.0/12,127.0.0.1,fd00::/8,172.16.0.0/12 ",
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
      expect(() => loadConfig({ HYPE_COMMS_TRUSTED_PROXIES: trustedProxies })).toThrow(ConfigError);
    }
  });

  it("requires an unguessable metrics token", () => {
    expect(() => loadConfig({ HYPE_COMMS_METRICS_TOKEN: "too-short" })).toThrow(ConfigError);
    expect(loadConfig({ HYPE_COMMS_METRICS_TOKEN: "m".repeat(32) })).toMatchObject({
      metricsToken: "m".repeat(32),
    });
  });

  it("requires a safe, environment-appropriate public API origin", () => {
    expect(() =>
      loadConfig({ HYPE_COMMS_PUBLIC_API_URL: "http://example.com/path?secret=value" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ NODE_ENV: "production", HYPE_COMMS_PUBLIC_API_URL: "http://api.example.com" }),
    ).toThrow(ConfigError);
  });

  it("requires PostgreSQL in production and exposes its bounded pool configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(
      loadConfig({
        NODE_ENV: "production",
        HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@postgres/hype_comms",
        HYPE_COMMS_DATABASE_POOL_SIZE: "7",
        HYPE_COMMS_EMAIL_DELIVERY: "manual",
      }),
    ).toMatchObject({
      database: {
        url: "postgres://hype_comms:secret@postgres/hype_comms",
        poolSize: 7,
      },
    });
  });

  it("loads SMTP and owner seed settings only when configured", () => {
    expect(
      loadConfig({
        HYPE_COMMS_SMTP_URL: "smtp://mail.example.com:2525",
        HYPE_COMMS_EMAIL_FROM: "Hype Comms <chat@example.com>",
        HYPE_COMMS_OWNER_EMAIL: "OWNER@EXAMPLE.COM",
        HYPE_COMMS_WORKSPACE_NAME: "Pilot",
        HYPE_COMMS_WORKSPACE_SLUG: "pilot",
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

  it("normalizes the pre-cutover workspace slug and warns about the stale value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Migration 0018 renamed the stored slug, so seeding "hmm-chat" would create a second
      // workspace instead of adopting the renamed one.
      expect(
        loadConfig({
          HYPE_COMMS_OWNER_EMAIL: "owner@example.com",
          HYPE_COMMS_WORKSPACE_SLUG: "hmm-chat",
        }),
      ).toMatchObject({ owner: { workspaceSlug: "hype-comms" } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("HYPE_COMMS_WORKSPACE_SLUG");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves every other configured workspace slug untouched and silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const workspaceSlug of ["pilot", "hmm", "hmm-chat-archive", "hype-comms"]) {
        expect(
          loadConfig({
            HYPE_COMMS_OWNER_EMAIL: "owner@example.com",
            HYPE_COMMS_WORKSPACE_SLUG: workspaceSlug,
          }),
        ).toMatchObject({ owner: { workspaceSlug } });
      }
      expect(loadConfig({ HYPE_COMMS_OWNER_EMAIL: "owner@example.com" })).toMatchObject({
        owner: { workspaceSlug: "hype-comms" },
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("requires SMTP URL and sender address together", () => {
    expect(() => loadConfig({ HYPE_COMMS_SMTP_URL: "smtp://mail.example.com:2525" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ HYPE_COMMS_EMAIL_FROM: "chat@example.com" })).toThrow(ConfigError);
  });

  it("loads an all-or-none staging AuthKit configuration", () => {
    expect(
      loadConfig({
        HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@127.0.0.1/hype_comms",
        WORKOS_API_KEY: "sk_test_example",
        WORKOS_CLIENT_ID: "client_example",
        WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback",
        HYPE_COMMS_AUTH_ENCRYPTION_KEY: "A".repeat(43),
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
        HYPE_COMMS_AUTH_ENCRYPTION_KEY: "A".repeat(43),
      }),
    ).toThrow(ConfigError);

    expect(() => loadConfig({ HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED: "true" })).toThrow(
      /WorkOS provider settings/,
    );
  });

  it("binds the AuthKit callback to the configured public origin", () => {
    const base = {
      HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@127.0.0.1/hype_comms",
      WORKOS_API_KEY: "sk_test_example",
      WORKOS_CLIENT_ID: "client_example",
      HYPE_COMMS_AUTH_ENCRYPTION_KEY: "A".repeat(43),
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

  it("pins AuthKit JWTs to the exact configurable HTTPS issuer", () => {
    const base = {
      HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@127.0.0.1/hype_comms",
      WORKOS_API_KEY: "sk_test_example",
      WORKOS_CLIENT_ID: "client_example",
      WORKOS_REDIRECT_URI: "http://127.0.0.1:3000/v1/auth/workos/callback",
      HYPE_COMMS_AUTH_ENCRYPTION_KEY: "A".repeat(43),
    };
    expect(loadConfig({ ...base, WORKOS_JWT_ISSUER: "https://auth.example.com" })).toMatchObject({
      workos: { jwtIssuer: "https://auth.example.com" },
    });
    expect(loadConfig({ ...base, WORKOS_JWT_ISSUER: "https://auth.example.com/" })).toMatchObject({
      workos: { jwtIssuer: "https://auth.example.com/" },
    });

    for (const issuer of [
      "http://auth.example.com",
      "https://auth.example.com/path",
      "https://auth.example.com//",
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
      HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:secret@postgres/hype_comms",
      HYPE_COMMS_EMAIL_DELIVERY: "manual",
      WORKOS_API_KEY: "sk_live_example",
      WORKOS_CLIENT_ID: "client_example",
      WORKOS_REDIRECT_URI: "https://chat-api.example.invalid/v1/auth/workos/callback",
      HYPE_COMMS_AUTH_ENCRYPTION_KEY: "A".repeat(43),
    };
    expect(loadConfig(environment)).toMatchObject({
      authKitAdmissionEnabled: false,
      trustedProxies: ["127.0.0.1", "::1"],
      workos: { clientId: "client_example" },
    });

    expect(
      loadConfig({
        ...environment,
        WORKOS_API_KEY: "sk_opaque_production_example",
      }),
    ).toMatchObject({
      authKitAdmissionEnabled: false,
      workos: { apiKey: "sk_opaque_production_example" },
    });

    expect(() =>
      loadConfig({ ...environment, HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED: "true" }),
    ).toThrow(/WORKOS_WEBHOOK_SECRET/);
    expect(
      loadConfig({
        ...environment,
        HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED: "true",
        WORKOS_WEBHOOK_SECRET: "whsec_example_secret",
        HYPE_COMMS_TRUSTED_PROXIES: "172.16.0.0/12",
      }),
    ).toMatchObject({
      authKitAdmissionEnabled: true,
      workos: { webhookSecret: "whsec_example_secret" },
      trustedProxies: ["172.16.0.0/12"],
    });

    expect(() =>
      loadConfig({
        ...environment,
        HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED: "true",
        WORKOS_WEBHOOK_SECRET: "whsec_example_secret",
      }),
    ).toThrow(/HYPE_COMMS_TRUSTED_PROXIES/);
  });
});
