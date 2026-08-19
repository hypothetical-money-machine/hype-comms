import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCurrentUserUrl,
  createIdentitySessionUrl,
  createMagicLinkUrl,
  createServerHealthUrl,
  DEFAULT_DEVELOPMENT_API_ORIGIN,
  DEFAULT_PRODUCTION_API_ORIGIN,
  normalizeDevelopmentApiOrigin,
  normalizeProductionApiOrigin,
} from "../shared/api-origin";
import { PRODUCTION_CONTENT_SECURITY_POLICY } from "../shared/security-policy";
import {
  AUTH_PROTOCOL_SCHEMES,
  createProtocolClientRegistration,
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
    const callback = "hype-comms://auth/callback?code=opaque&state=opaque";
    expect(normalizeAuthCallbackUrl(callback, AUTH_PROTOCOL_SCHEMES.production)).toBe(callback);
    expect(findAuthCallbackUrl(["--flag", callback], AUTH_PROTOCOL_SCHEMES.production)).toBe(
      callback,
    );
  });

  it.each([
    "https://auth/callback?code=opaque",
    "hype-comms://auth/other?code=opaque",
    "hype-comms://settings/callback",
    "hype-comms://user:secret@auth/callback",
  ])("rejects unexpected callback URL %s", (url) => {
    expect(normalizeAuthCallbackUrl(url, AUTH_PROTOCOL_SCHEMES.production)).toBeNull();
  });

  it("keeps route normalization compatible with legacy and AuthKit callback shapes", () => {
    const magicLink = `hype-comms://auth/callback?token=${"m".repeat(43)}`;
    const authKit = `hype-comms://auth/callback?code=${"c".repeat(43)}&state=${"s".repeat(43)}`;

    expect(normalizeAuthCallbackUrl(magicLink, AUTH_PROTOCOL_SCHEMES.production)).toBe(magicLink);
    expect(normalizeAuthCallbackUrl(authKit, AUTH_PROTOCOL_SCHEMES.production)).toBe(authKit);
    expect(findAuthCallbackUrl([magicLink, authKit], AUTH_PROTOCOL_SCHEMES.production)).toBe(
      magicLink,
    );
  });

  it("isolates production and development callbacks by scheme", () => {
    const production = `hype-comms://auth/callback?token=${"p".repeat(43)}`;
    const development = `hype-comms-dev://auth/callback?token=${"d".repeat(43)}`;

    expect(normalizeAuthCallbackUrl(production, AUTH_PROTOCOL_SCHEMES.production)).toBe(production);
    expect(normalizeAuthCallbackUrl(development, AUTH_PROTOCOL_SCHEMES.development)).toBe(
      development,
    );
    expect(normalizeAuthCallbackUrl(production, AUTH_PROTOCOL_SCHEMES.development)).toBeNull();
    expect(normalizeAuthCallbackUrl(development, AUTH_PROTOCOL_SCHEMES.production)).toBeNull();
    expect(findAuthCallbackUrl([production, development], AUTH_PROTOCOL_SCHEMES.development)).toBe(
      development,
    );
  });
});

describe("authentication protocol registration", () => {
  it("keeps packaged registration on the scheme-only Electron path", () => {
    expect(
      createProtocolClientRegistration(
        true,
        "/Applications/Hype Comms",
        ["/Applications/Hype Comms"],
        AUTH_PROTOCOL_SCHEMES.production,
      ),
    ).toEqual({ scheme: "hype-comms" });
  });

  it("registers an unpackaged Electron executable with its app script", () => {
    expect(
      createProtocolClientRegistration(
        false,
        "/opt/electron",
        ["/opt/electron", "./apps/desktop"],
        AUTH_PROTOCOL_SCHEMES.development,
      ),
    ).toEqual({
      scheme: "hype-comms-dev",
      executablePath: "/opt/electron",
      arguments: [path.resolve("./apps/desktop")],
    });
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
      "https://chat-api.example.invalid/livez",
    );
    expect(createIdentitySessionUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "https://chat-api.example.invalid/v1/auth/session",
    );
    expect(createCurrentUserUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "https://chat-api.example.invalid/v1/auth/me",
    );
    expect(createMagicLinkUrl(DEFAULT_PRODUCTION_API_ORIGIN)).toBe(
      "https://chat-api.example.invalid/v1/auth/magic-link",
    );
  });

  it.each([
    "http://chat-api.example.invalid",
    "https://user:secret@chat-api.example.invalid",
    "https://chat-api.example.invalid/v1",
    "https://chat-api.example.invalid?tenant=hmm",
    "not a URL",
  ])("rejects production API configuration that is not a safe HTTPS origin: %s", (origin) => {
    expect(normalizeProductionApiOrigin(origin)).toBeNull();
  });

  it.each([
    "http://0.0.0.0:3000",
    "http://example.com:3000",
    "http://127.0.0.1:3000/v1",
    "https://user:secret@chat-api.example.invalid",
    "not a URL",
  ])("rejects development API configuration that is not loopback HTTP or HTTPS: %s", (origin) => {
    expect(normalizeDevelopmentApiOrigin(origin)).toBeNull();
  });

  it.each(["https://127.0.0.1:3000", "https://chat-api.example.invalid"])(
    "lets a development build reach an HTTPS deployment: %s",
    (origin) => {
      expect(normalizeDevelopmentApiOrigin(origin)).toBe(origin);
    },
  );
});
