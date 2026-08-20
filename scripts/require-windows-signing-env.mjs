import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_SIGNING_ABSENT_MESSAGE,
  WINDOWS_SIGNING_ENV_NAMES,
  formatIncompleteWindowsSigningError,
  readWindowsSigningInputs,
  windowsAzureAuthEnvironment,
} from "../apps/desktop/windows-signing.mjs";

export const WINDOWS_SIGNING_ENABLED_ENV = "HYPE_COMMS_WINDOWS_SIGNING_ENABLED";

export function githubEnvAssignments(values) {
  return {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    [WINDOWS_SIGNING_ENABLED_ENV]: "true",
    ...windowsAzureAuthEnvironment(values),
    ...Object.fromEntries(WINDOWS_SIGNING_ENV_NAMES.map((name) => [name, values[name]])),
  };
}

function writeGithubEnv(env, assignments, writeFile) {
  if (!isPresent(env.GITHUB_ENV)) {
    return;
  }
  writeFile(
    env.GITHUB_ENV,
    `${Object.entries(assignments)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
}

export function configureWindowsSigningEnv(
  env = process.env,
  writeFile = (file, contents) => appendFileSync(file, contents),
) {
  const { missing, present, values } = readWindowsSigningInputs(env);
  if (present.length === 0) {
    writeGithubEnv(env, { [WINDOWS_SIGNING_ENABLED_ENV]: "false" }, writeFile);
    return { status: "absent" };
  }
  if (missing.length > 0) {
    throw new Error(formatIncompleteWindowsSigningError(missing, present));
  }

  writeGithubEnv(env, githubEnvAssignments(values), writeFile);
  return {
    status: "configured",
    endpoint: values.HYPE_COMMS_WINDOWS_AZURE_ENDPOINT,
    publisherName: values.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
  };
}

const isPresent = (value) => typeof value === "string" && value.trim() !== "";

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  try {
    const configured = configureWindowsSigningEnv();
    if (configured.status === "absent") {
      console.log(WINDOWS_SIGNING_ABSENT_MESSAGE);
    } else {
      console.log(
        `Windows Authenticode signing is configured for publisher ${configured.publisherName} at ${configured.endpoint}.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
