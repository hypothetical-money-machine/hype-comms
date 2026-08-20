export const WINDOWS_SIGNING_RUNBOOK = "docs/windows-signing.md";

export const WINDOWS_SIGNING_SECRET_NAMES = Object.freeze([
  "HYPE_COMMS_WINDOWS_AZURE_TENANT_ID",
  "HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID",
  "HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET",
]);

export const WINDOWS_SIGNING_VARIABLE_NAMES = Object.freeze([
  "HYPE_COMMS_WINDOWS_AZURE_ENDPOINT",
  "HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME",
  "HYPE_COMMS_WINDOWS_PUBLISHER_NAME",
]);

export const WINDOWS_SIGNING_ENV_NAMES = Object.freeze([
  ...WINDOWS_SIGNING_SECRET_NAMES,
  ...WINDOWS_SIGNING_VARIABLE_NAMES,
]);

export const WINDOWS_AZURE_AUTH_ENV = Object.freeze({
  HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: "AZURE_TENANT_ID",
  HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID: "AZURE_CLIENT_ID",
  HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET: "AZURE_CLIENT_SECRET",
});

const isPresent = (value) => typeof value === "string" && value.trim() !== "";

export function isWindowsPackagingRequested(argv = process.argv, platform = process.platform) {
  const requestedWindows = argv.includes("--win");
  const requestedMac = argv.includes("--mac");
  const requestedLinux = argv.includes("--linux");
  if (requestedWindows) {
    return true;
  }
  if (requestedMac || requestedLinux) {
    return false;
  }
  return platform === "win32";
}

export function readWindowsSigningInputs(env = process.env) {
  const values = {};
  const present = [];
  const missing = [];

  for (const name of WINDOWS_SIGNING_ENV_NAMES) {
    const value = env[name];
    if (isPresent(value)) {
      values[name] = value.trim();
      present.push(name);
    } else {
      missing.push(name);
    }
  }

  return { missing, present, values };
}

export const WINDOWS_SIGNING_ABSENT_MESSAGE =
  "Windows Authenticode signing is not configured; publishing an unsigned Windows artifact. See docs/windows-signing.md.";

export function formatIncompleteWindowsSigningError(missing, present) {
  return [
    "Windows Authenticode signing is partially configured and refuses to emit an unsigned artifact.",
    `Present: ${present.join(", ")}.`,
    `Missing: ${missing.join(", ")}.`,
    `Add the remaining repository secrets and variables listed in ${WINDOWS_SIGNING_RUNBOOK}, or remove the partial values.`,
  ].join(" ");
}

export function resolveWindowsSigningConfiguration({
  flavor,
  env = process.env,
  argv = process.argv,
  platform = process.platform,
} = {}) {
  const windowsPackaging = isWindowsPackagingRequested(argv, platform);
  if (!flavor?.isProduction || !windowsPackaging) {
    return { status: "disabled" };
  }

  const { missing, present, values } = readWindowsSigningInputs(env);
  if (present.length === 0) {
    return { status: "absent" };
  }
  if (missing.length > 0) {
    throw new Error(formatIncompleteWindowsSigningError(missing, present));
  }

  return {
    status: "configured",
    publisherName: values.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
    azureSignOptions: {
      publisherName: values.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
      endpoint: values.HYPE_COMMS_WINDOWS_AZURE_ENDPOINT,
      codeSigningAccountName: values.HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME,
      certificateProfileName: values.HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME,
    },
  };
}

export function windowsAzureAuthEnvironment(values) {
  return Object.fromEntries(
    Object.entries(WINDOWS_AZURE_AUTH_ENV).map(([source, target]) => [target, values[source]]),
  );
}
