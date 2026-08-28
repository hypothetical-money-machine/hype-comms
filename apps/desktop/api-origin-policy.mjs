export function isReservedInvalidHostname(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/u, "");
  return normalizedHostname === "invalid" || normalizedHostname.endsWith(".invalid");
}
