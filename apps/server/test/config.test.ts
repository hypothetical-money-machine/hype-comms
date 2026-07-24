import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      allowedOrigins: ["http://127.0.0.1:5173"],
      publicApiUrl: "http://127.0.0.1:3000",
    });
  });

  it("uses the pilot API and packaged renderer origins in production", () => {
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({
      allowedOrigins: ["app://bundle"],
      publicApiUrl: "https://api.chat.hypemm.com",
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
});
