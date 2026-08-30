export const DEFAULT_DEVELOPMENT_API_ORIGIN = "http://127.0.0.1:3000";
export const DEFAULT_PRODUCTION_API_ORIGIN = "https://chat-api.example.invalid";
/**
 * The deployed production API, as baked into release packages by the desktop-release workflow's
 * HYPE_COMMS_API_ORIGIN. Only packages aimed at this origin may consume the public update feed;
 * DEFAULT_PRODUCTION_API_ORIGIN stays a reserved-invalid placeholder so an unconfigured
 * production build fails closed instead of silently targeting a real host.
 */
export const OFFICIAL_PRODUCTION_API_ORIGIN = "https://chat-api.hypemm.com";

function parseBareOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

/**
 * Development builds may talk to a loopback server over plain HTTP, or to any HTTPS deployment.
 * Plain HTTP to a non-loopback host stays rejected so session cookies and message data never cross
 * the network without transport encryption.
 */
export function normalizeDevelopmentApiOrigin(value: string): string | null {
  const url = parseBareOrigin(value);
  if (url === null) {
    return null;
  }
  if (url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    return url.origin;
  }

  return null;
}

export function normalizeProductionApiOrigin(value: string): string | null {
  const url = parseBareOrigin(value);
  return url !== null && url.protocol === "https:" ? url.origin : null;
}

export function createServerHealthUrl(apiOrigin: string): string {
  return new URL("/livez", apiOrigin).href;
}

export function createIdentitySessionUrl(apiOrigin: string): string {
  return new URL("/v1/auth/session", apiOrigin).href;
}

export function createCurrentUserUrl(apiOrigin: string): string {
  return new URL("/v1/auth/me", apiOrigin).href;
}

export function createMagicLinkUrl(apiOrigin: string): string {
  return new URL("/v1/auth/magic-link", apiOrigin).href;
}

export function createAuthCapabilitiesUrl(apiOrigin: string): string {
  return new URL("/v1/auth/capabilities", apiOrigin).href;
}

export function createDesktopAuthorizationUrl(apiOrigin: string): string {
  return new URL("/v1/auth/desktop-authorizations", apiOrigin).href;
}

export function createAuthHandoffExchangeUrl(apiOrigin: string): string {
  return new URL("/v1/auth/exchange", apiOrigin).href;
}
