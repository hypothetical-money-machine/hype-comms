import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function requireEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

const updateManifest = requireEnvironment("UPDATE_MANIFEST");
const publicRoot = requireEnvironment("HMM_UPDATE_PUBLIC_ROOT");
const desktopVersion = requireEnvironment("DESKTOP_VERSION");
const localManifest = readFileSync(`apps/desktop/release/${updateManifest}`, "utf8");
const feedRoot = new URL(`${publicRoot}/`);
const manifestUrl = new URL(updateManifest, feedRoot);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchOk(url) {
  let failure = "no response";
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60 * 1_000),
      });
      if (response.ok) return response;
      failure = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 12) await sleep(5_000);
  }
  throw new Error(`Could not fetch ${url.href}: ${failure}`);
}

let manifestResponse;
let publishedManifest = "";
for (let attempt = 1; attempt <= 12; attempt += 1) {
  manifestResponse = await fetchOk(manifestUrl);
  publishedManifest = await manifestResponse.text();
  if (publishedManifest === localManifest) break;
  if (attempt < 12) await sleep(5_000);
}
if (publishedManifest !== localManifest) {
  throw new Error(`${manifestUrl.href} does not contain the manifest just published`);
}
if (!/\bno-cache\b/i.test(manifestResponse.headers.get("cache-control") ?? "")) {
  throw new Error(`${manifestUrl.href} is not served with Cache-Control: no-cache`);
}

const lines = localManifest.split(/\r?\n/u);
const files = [];
for (let index = 0; index < lines.length; index += 1) {
  const url = lines[index].match(/^ {2}- url:\s*(.+)\s*$/u);
  if (url === null) continue;
  const sha512 = lines[index + 1]?.match(/^ {4}sha512:\s*(\S+)\s*$/u);
  const size = lines[index + 2]?.match(/^ {4}size:\s*(\d+)\s*$/u);
  if (sha512 === null || sha512 === undefined || size === null || size === undefined) {
    throw new Error(`Could not parse the file entry for ${url[1]}`);
  }
  files.push({ url: url[1], sha512: sha512[1], size: Number(size[1]) });
}
if (files.length === 0) throw new Error("Published manifest contains no files");

for (const file of files) {
  const artifactUrl = new URL(file.url, feedRoot);
  if (
    artifactUrl.origin !== feedRoot.origin ||
    !artifactUrl.pathname.startsWith(feedRoot.pathname)
  ) {
    throw new Error(`Manifest artifact escapes the canonical feed: ${file.url}`);
  }
  const response = await fetchOk(artifactUrl);
  if (!/\bimmutable\b/i.test(response.headers.get("cache-control") ?? "")) {
    throw new Error(`${artifactUrl.href} is not served with immutable caching`);
  }

  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (size !== file.size || hash.digest("base64") !== file.sha512) {
    throw new Error(`${artifactUrl.href} does not match ${updateManifest}`);
  }
}

console.log(
  `Verified ${updateManifest} and ${files.length} public artifact(s) for ${desktopVersion}.`,
);
