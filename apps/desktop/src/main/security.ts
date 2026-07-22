import path from "node:path";

export const APP_PROTOCOL = "app";
export const APP_PROTOCOL_HOST = "bundle";
export const AUTH_PROTOCOL = "hmm-chat:";
export const MAX_URL_LENGTH = 4_096;

export function normalizeExternalHttpsUrl(value: string): string | null {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function normalizeDevelopmentServerUrl(value: string): string | null {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value);
    const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      url.protocol !== "http:" ||
      !isLoopback ||
      url.port !== "5173" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function isTrustedRendererUrl(value: string, developmentServerUrl: string | null): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }

  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") {
      return false;
    }

    if (
      url.protocol === `${APP_PROTOCOL}:` &&
      url.hostname === APP_PROTOCOL_HOST &&
      url.port === ""
    ) {
      return true;
    }

    const normalizedDevelopmentUrl =
      developmentServerUrl === null ? null : normalizeDevelopmentServerUrl(developmentServerUrl);
    return (
      normalizedDevelopmentUrl !== null && url.origin === new URL(normalizedDevelopmentUrl).origin
    );
  } catch {
    return false;
  }
}

export function normalizeAuthCallbackUrl(value: string): string | null {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== AUTH_PROTOCOL ||
      url.hostname !== "auth" ||
      url.pathname !== "/callback" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export function findAuthCallbackUrl(argumentsList: readonly string[]): string | null {
  for (const argument of argumentsList) {
    const callbackUrl = normalizeAuthCallbackUrl(argument);
    if (callbackUrl !== null) {
      return callbackUrl;
    }
  }

  return null;
}

export function resolveRendererAssetPath(rendererRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${APP_PROTOCOL}:` ||
    url.hostname !== APP_PROTOCOL_HOST ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return null;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const absoluteRoot = path.resolve(rendererRoot);
  const absolutePath = path.resolve(absoluteRoot, `.${requestedPath}`);
  const isInsideRoot =
    absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${path.sep}`);

  return isInsideRoot ? absolutePath : null;
}
