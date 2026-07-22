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

export function normalizeDevelopmentApiOrigin(value: string): string | null {
  const url = parseBareOrigin(value);
  if (
    url === null ||
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    return null;
  }

  return url.origin;
}

export function normalizeProductionApiOrigin(value: string): string | null {
  const url = parseBareOrigin(value);
  return url !== null && url.protocol === "https:" ? url.origin : null;
}

export function createServerHealthUrl(apiOrigin: string): string {
  return new URL("/livez", apiOrigin).href;
}

export function createDevelopmentWelcomeMessagesUrl(apiOrigin: string): string {
  return new URL("/v1/development/welcome/messages", apiOrigin).href;
}

export function createDevelopmentWelcomeRealtimeUrl(apiOrigin: string): string {
  const url = new URL("/v1/development/welcome/realtime", apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
