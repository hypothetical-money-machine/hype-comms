import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSessionUrl,
  createWelcomeMessagesUrl,
  createWelcomeRealtimeUrl,
  createServerHealthUrl,
  DEFAULT_DEVELOPMENT_API_ORIGIN,
  DEFAULT_PRODUCTION_API_ORIGIN,
  normalizeDevelopmentApiOrigin,
  normalizeProductionApiOrigin,
} from "../shared/api-origin";
import { PRODUCTION_CONTENT_SECURITY_POLICY } from "../shared/security-policy";
import {
  findAuthCallbackUrl,
  isTrustedRendererUrl,
  normalizeAuthCallbackUrl,
  normalizeDevelopmentServerUrl,
  normalizeExternalHttpsUrl,
  resolveRendererAssetPath,
} from "./security";

describe("normalizeExternalHttpsUrl", () => {
  it("allows credential-free HTTPS URLs", () => {
    expect(normalizeExternalHttpsUrl("https://example.com/docs?q=chat")).toBe(
      "https://example.com/docs?q=chat",
    );
  });

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "not a URL",
  ])("rejects unsafe external URL %s", (url) => {
    expect(normalizeExternalHttpsUrl(url)).toBeNull();
  });
});

describe("normalizeDevelopmentServerUrl", () => {
  it.each(["http://127.0.0.1:5173/", "http://localhost:5173/"])(
    "allows the configured loopback Vite origin %s",
    (url) => {
      expect(normalizeDevelopmentServerUrl(url)).toBe(url);
    },
  );

  it.each([
    "https://127.0.0.1:5173/",
    "http://0.0.0.0:5173/",
    "http://localhost:4173/",
    "http://example.com:5173/",
  ])("rejects unexpected development origin %s", (url) => {
    expect(normalizeDevelopmentServerUrl(url)).toBeNull();
  });
});

describe("isTrustedRendererUrl", () => {
  it("trusts the bundled renderer origin without trusting lookalikes", () => {
    expect(isTrustedRendererUrl("app://bundle/index.html", null)).toBe(true);
    expect(isTrustedRendererUrl("app://bundle/settings", null)).toBe(true);
    expect(isTrustedRendererUrl("app://bundle.example/index.html", null)).toBe(false);
    expect(isTrustedRendererUrl("https://bundle/index.html", null)).toBe(false);
  });

  it("trusts only the configured development origin", () => {
    const developmentUrl = "http://127.0.0.1:5173/";
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/", developmentUrl)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/channel/general", developmentUrl)).toBe(
      true,
    );
    expect(isTrustedRendererUrl("http://localhost:5173/", developmentUrl)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/", developmentUrl)).toBe(false);
  });
});

describe("authentication callback validation", () => {
  it("accepts only the dedicated auth callback route", () => {
    const callback = "hmm-chat://auth/callback?code=opaque&state=opaque";
    expect(normalizeAuthCallbackUrl(callback)).toBe(callback);
    expect(findAuthCallbackUrl(["--flag", callback])).toBe(callback);
  });

  it.each([
    "https://auth/callback?code=opaque",
    "hmm-chat://auth/other?code=opaque",
    "hmm-chat://settings/callback",
    "hmm-chat://user:secret@auth/callback",
  ])("rejects unexpected callback URL %s", (url) => {
    expect(normalizeAuthCallbackUrl(url)).toBeNull();
  });
});

describe("resolveRendererAssetPath", () => {
  const rendererRoot = path.join(path.sep, "application", "dist", "renderer");

  it("maps the app root and bundled assets inside the renderer directory", () => {
    expect(resolveRendererAssetPath(rendererRoot, "app://bundle/")).toBe(
      path.join(rendererRoot, "index.html"),
    );
    expect(resolveRendererAssetPath(rendererRoot, "app://bundle/assets/main.js")).toBe(
      path.join(rendererRoot, "assets", "main.js"),
    );
  });

  it.each([
    "app://other/index.html",
    "https://bundle/index.html",
    "app://bundle/..%2Fsecrets.txt",
    "app://bundle/assets%5C..%5Csecrets.txt",
    "not a URL",
  ])("rejects malformed or escaping asset request %s", (url) => {
    expect(resolveRendererAssetPath(rendererRoot, url)).toBeNull();
  });
});

describe("production content security policy", () => {
  it("does not permit renderer network access, inline script, eval, or embedding", () => {
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-inline'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain("http:");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain("https:");
  });
});

describe("API origin validation", () => {
  it("accepts the dedicated development and production origin classes", () => {
    expect(normalizeDevelopmentApiOrigin(`${DEFAULT_DEVELOPMENT_API_ORIGIN}/`)).toBe(
      DEFAULT_DEVELOPMENT_API_ORIGIN,
    );
    expect(normalizeProductionApiOrigin(`${DEFAULT_PRODUCTION_API_ORIGIN}/`)).toBe(
      DEFAULT_PRODUCTION_API_ORIGIN,
    );
    expect(createServerHealthUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "https://api.chat.hypemm.com/livez",
    );
    expect(createSessionUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "https://api.chat.hypemm.com/v1/chat/session",
    );
    expect(createWelcomeMessagesUrl(DEFAULT_DEVELOPMENT_API_ORIGIN)).toBe(
      "http://127.0.0.1:3000/v1/chat/welcome/messages",
    );
    expect(createWelcomeRealtimeUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "wss://api.chat.hypemm.com/v1/chat/welcome/realtime",
    );
  });

  it.each([
    "http://api.chat.hypemm.com",
    "https://user:secret@api.chat.hypemm.com",
    "https://api.chat.hypemm.com/v1",
    "https://api.chat.hypemm.com?tenant=hmm",
    "not a URL",
  ])("rejects production API configuration that is not a safe HTTPS origin: %s", (origin) => {
    expect(normalizeProductionApiOrigin(origin)).toBeNull();
  });

  it.each([
    "http://0.0.0.0:3000",
    "http://example.com:3000",
    "http://127.0.0.1:3000/v1",
    "https://user:secret@chat.hypemm.com",
    "not a URL",
  ])("rejects development API configuration that is not loopback HTTP or HTTPS: %s", (origin) => {
    expect(normalizeDevelopmentApiOrigin(origin)).toBeNull();
  });

  it.each(["https://127.0.0.1:3000", "https://chat.hypemm.com"])(
    "lets a development build reach an HTTPS deployment: %s",
    (origin) => {
      expect(normalizeDevelopmentApiOrigin(origin)).toBe(origin);
    },
  );
});
