import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local development runs the same authenticated chat path as a deployment, so the server needs
 * dogfood mode and an access code. This code is a fixed local-only value: it never leaves the
 * loopback interface and is printed on startup so both development clients can sign in.
 */
export const DEVELOPMENT_ACCESS_CODE = "local-development-access-code";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEVELOPMENT_SERVER_ENV = Object.freeze({
  HMM_DOGFOOD_ENABLED: "true",
  HMM_DOGFOOD_ACCESS_CODE: DEVELOPMENT_ACCESS_CODE,
  HMM_DOGFOOD_DATA_PATH: path.join(repositoryRoot, ".dev-data", "hmm-chat.sqlite"),
});

export function describeDevelopmentAccess() {
  return `Sign in with access code: ${DEVELOPMENT_ACCESS_CODE}`;
}
