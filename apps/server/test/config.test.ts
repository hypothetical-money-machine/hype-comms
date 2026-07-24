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
    });
  });

  it("uses the pilot API and packaged renderer origins in production", () => {
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({
      allowedOrigins: ["app://bundle"],
      publicApiUrl: "https://chat-api.example.invalid",
      cookieSecure: true,
    });
  });

  it("rejects malformed ports and origins", () => {
    expect(() => loadConfig({ HMM_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ HMM_ALLOWED_ORIGINS: "https://chat.example/path" })).toThrow(
      ConfigError,
    );
  });

  it("requires a safe, environment-appropriate public API origin", () => {
    expect(() =>
      loadConfig({ HMM_PUBLIC_API_URL: "http://example.com/path?secret=value" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ NODE_ENV: "production", HMM_PUBLIC_API_URL: "http://api.example.com" }),
    ).toThrow(ConfigError);
  });

  it("requires a strong access code when chat mode is enabled", () => {
    expect(() => loadConfig({ HMM_CHAT_ENABLED: "true" })).toThrow(ConfigError);
    expect(
      loadConfig({
        HMM_CHAT_ENABLED: "true",
        HMM_CHAT_ACCESS_CODE: "a-secure-weekend-access-code",
      }),
    ).toMatchObject({
      chat: {
        enabled: true,
        accessCode: "a-secure-weekend-access-code",
        dataPath: "/data/hmm-chat.sqlite",
      },
    });
  });

  it("loads SMTP and owner seed settings only when configured", () => {
    expect(
      loadConfig({
        HMM_SMTP_URL: "smtp://mail.example.com:2525",
        HMM_EMAIL_FROM: "HMM Chat <chat@example.com>",
        HMM_OWNER_EMAIL: "OWNER@EXAMPLE.COM",
        HMM_WORKSPACE_NAME: "Pilot",
        HMM_WORKSPACE_SLUG: "pilot",
      }),
    ).toMatchObject({
      smtp: {
        url: "smtp://mail.example.com:2525",
        from: "HMM Chat <chat@example.com>",
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
});
