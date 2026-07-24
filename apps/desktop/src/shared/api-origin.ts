export const DEFAULT_DEVELOPMENT_API_ORIGIN = "http://127.0.0.1:3000";
export const DEFAULT_PRODUCTION_API_ORIGIN = "https://api.chat.hypemm.com";

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
 * Plain HTTP to a non-loopback host stays rejected: that is the case where an access code and a
 * session cookie would cross the network in the clear.
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

export function createSessionUrl(apiOrigin: string): string {
  return new URL("/v1/dogfood/session", apiOrigin).href;
}

export function createWelcomeMessagesUrl(apiOrigin: string): string {
  return new URL("/v1/dogfood/welcome/messages", apiOrigin).href;
}

export function createWelcomeRealtimeUrl(apiOrigin: string): string {
  const url = new URL("/v1/dogfood/welcome/realtime", apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
