const MAILTO_ALLOWED_QUERY_KEYS = new Set(["to", "cc", "bcc", "subject", "body"]);
const CONTROL_CHARACTERS = /\p{Cc}/u;

export const MAX_MAILTO_URL_LENGTH = 2_048;

function decodedComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function containsControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

function isAllowedMailtoQueryKey(key: string): boolean {
  return MAILTO_ALLOWED_QUERY_KEYS.has(key);
}

function isValidAddressValue(value: string): boolean {
  if (value === "" || /\s/u.test(value)) return false;
  const atSign = value.indexOf("@");
  if (atSign <= 0 || atSign === value.length - 1) return false;
  if (value.indexOf("@", atSign + 1) !== -1) return false;
  const domain = value.slice(atSign + 1);
  return !/[/\\?#:%]/u.test(domain) && !containsControlCharacters(value);
}

function hasRecipient(pathname: string, query: URLSearchParams): boolean {
  if (pathname !== "") return true;
  return ["to", "cc", "bcc"].some((key) => (query.get(key) ?? "") !== "");
}

function validateRecipientList(value: string): boolean {
  return value.split(",").every(isValidAddressValue);
}

export function normalizeExternalMailtoUrl(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > MAX_MAILTO_URL_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "mailto:" || containsControlCharacters(url.href)) {
    return null;
  }

  const pathname = decodedComponent(url.pathname);
  if (pathname === null) return null;

  for (const [key, rawValue] of url.searchParams) {
    if (!isAllowedMailtoQueryKey(key)) return null;
    const decodedValue = decodedComponent(rawValue);
    if (decodedValue === null) return null;
    if (key === "body") {
      const withoutLineBreaks = decodedValue.replace(/\r?\n/gu, "");
      if (containsControlCharacters(withoutLineBreaks)) return null;
      continue;
    }
    if (key === "subject") {
      if (containsControlCharacters(decodedValue)) return null;
      continue;
    }
    if (!validateRecipientList(decodedValue)) return null;
  }

  if (pathname !== "" && !validateRecipientList(pathname)) {
    return null;
  }
  if (!hasRecipient(pathname, url.searchParams)) {
    return null;
  }

  return url.href;
}
