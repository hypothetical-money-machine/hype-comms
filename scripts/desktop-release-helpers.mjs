import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultReleaseDirectory = path.join("apps", "desktop", "release");
const githubReleaseManifests = [
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
];
const githubReleaseArtifactPlatforms = ["mac", "win", "linux"];

export function requireEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function parseManifestVersion(manifest) {
  const match = manifest.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/mu);
  if (match === null) {
    throw new Error("Manifest has no valid version");
  }
  return match[1];
}

export function missingGithubReleaseAssets(assetNames, desktopVersion) {
  const names = new Set(assetNames);
  const missing = githubReleaseManifests.filter((manifest) => !names.has(manifest));
  for (const platform of githubReleaseArtifactPlatforms) {
    const prefix = `hype-comms-${desktopVersion}-${platform}-`;
    if (!assetNames.some((name) => name.startsWith(prefix))) {
      missing.push(`${prefix}*`);
    }
  }
  return missing;
}

function parseGithubReleaseAssetNames(payload, tagName) {
  if (!Array.isArray(payload)) {
    throw new Error("GitHub releases response must be an array");
  }
  let selectedRelease;
  for (const release of payload) {
    if (
      typeof release !== "object" ||
      release === null ||
      Array.isArray(release) ||
      typeof release.tag_name !== "string"
    ) {
      throw new Error("GitHub releases must have string tag names");
    }
    if (release.tag_name === tagName) {
      if (selectedRelease !== undefined) {
        throw new Error(`GitHub releases response contains duplicate tag ${tagName}`);
      }
      selectedRelease = release;
    }
  }
  if (selectedRelease === undefined) {
    throw new Error(`GitHub releases response does not contain draft tag ${tagName}`);
  }
  if (!Array.isArray(selectedRelease.assets)) {
    throw new Error("GitHub release response must contain an assets array");
  }
  return selectedRelease.assets.map((asset) => {
    if (
      typeof asset !== "object" ||
      asset === null ||
      Array.isArray(asset) ||
      typeof asset.name !== "string" ||
      asset.name === ""
    ) {
      throw new Error("GitHub release assets must have non-empty string names");
    }
    return asset.name;
  });
}

export async function waitForGithubReleaseAssets({
  attempts = 60,
  delayMilliseconds = 10_000,
  environment = process.env,
  fetchImplementation = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  if (!Number.isInteger(delayMilliseconds) || delayMilliseconds < 0) {
    throw new Error("delayMilliseconds must be a non-negative integer");
  }

  const desktopVersion = requireEnvironment("DESKTOP_VERSION", environment);
  const repository = requireEnvironment("GITHUB_REPOSITORY", environment);
  const repositoryParts = repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part === "")) {
    throw new Error("GITHUB_REPOSITORY must use owner/name format");
  }
  const tagName = requireEnvironment("GITHUB_REF_NAME", environment);
  const token = requireEnvironment("GH_TOKEN", environment);
  const apiRoot = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/u, "");
  const repositoryPath = repositoryParts.map(encodeURIComponent).join("/");
  // GitHub's release-by-tag endpoint returns 404 for drafts. The authenticated list endpoint
  // includes drafts, and the current serialized release is always among its 100 newest entries.
  const releasesUrl = new URL(`${apiRoot}/repos/${repositoryPath}/releases?per_page=100`);
  let lastError;
  let missing = missingGithubReleaseAssets([], desktopVersion);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(releasesUrl, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "cache-control": "no-cache",
          "user-agent": "hype-comms-desktop-release",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`GitHub release lookup returned HTTP ${response.status}`);
      }
      const assetNames = parseGithubReleaseAssetNames(await response.json(), tagName);
      missing = missingGithubReleaseAssets(assetNames, desktopVersion);
      if (missing.length === 0) return;
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      await sleep(delayMilliseconds);
    }
  }

  const detail =
    lastError === undefined ? ` Missing: ${missing.join(", ")}.` : ` Last error: ${lastError}.`;
  throw new Error(
    `Timed out waiting for all platform assets in the draft GitHub Release.${detail}`,
  );
}

export function addArtifactCacheKeys(manifest) {
  const artifactLinePattern = /^[ \t]*(?:-[ \t]+)?(?:url|path):[ \t]+\S+[ \t]*\r?$/gmu;
  const artifactPairPattern =
    /^([ \t]*(?:-[ \t]+)?(?:url|path):[ \t]+)(\S+)([ \t]*\r?\n[ \t]*sha512:[ \t]+)(\S+)([ \t]*\r?$)/gmu;
  const artifactLineCount = [...manifest.matchAll(artifactLinePattern)].length;
  let replacementCount = 0;

  const cacheKeyedManifest = manifest.replace(
    artifactPairPattern,
    (match, prefix, artifactUrl, hashPrefix, hash, suffix) => {
      if (/[?&]sha512=/u.test(artifactUrl)) {
        throw new Error(`${artifactUrl} already has a SHA-512 cache key`);
      }
      if (/["'?#]/u.test(artifactUrl)) {
        throw new Error(
          `${artifactUrl} must be an unquoted artifact URL without a query or fragment`,
        );
      }
      replacementCount += 1;
      return `${prefix}${artifactUrl}?sha512=${encodeURIComponent(hash)}${hashPrefix}${hash}${suffix}`;
    },
  );

  if (artifactLineCount === 0) {
    throw new Error("Manifest contains no artifact URLs");
  }
  if (replacementCount !== artifactLineCount) {
    throw new Error(
      `Manifest contains ${artifactLineCount} artifact URL(s), but only ` +
        `${replacementCount} immediately precede a SHA-512 hash`,
    );
  }
  return cacheKeyedManifest;
}

export async function cacheKeyPlatformManifest({
  environment = process.env,
  releaseDirectory = defaultReleaseDirectory,
} = {}) {
  const updateManifest = requireEnvironment("UPDATE_MANIFEST", environment);
  const manifestPath = path.join(releaseDirectory, updateManifest);
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, addArtifactCacheKeys(manifest));
}

export function selectArtifactNames(entries, desktopVersion, artifactOs) {
  const prefix = `hype-comms-${desktopVersion}-${artifactOs}-`;
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

// The publish job runs on a fresh runner without node_modules, so version comparison cannot come
// from a dependency. Desktop releases are plain x.y.z; anything else, prereleases included, is
// rejected outright rather than compared loosely.
function parseVersionTriple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) {
    throw new Error(`Unsupported desktop version "${version}"; expected x.y.z`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionGreater(candidate, published) {
  const candidateTriple = parseVersionTriple(candidate);
  const publishedTriple = parseVersionTriple(published);
  for (let index = 0; index < 3; index += 1) {
    if (candidateTriple[index] !== publishedTriple[index]) {
      return candidateTriple[index] > publishedTriple[index];
    }
  }
  return false;
}

export async function assertVersionCanPublish({
  environment = process.env,
  fetchImplementation = fetch,
} = {}) {
  const updateManifest = requireEnvironment("UPDATE_MANIFEST", environment);
  const publicRoot = requireEnvironment("HYPE_COMMS_UPDATE_PUBLIC_ROOT", environment);
  const desktopVersion = requireEnvironment("DESKTOP_VERSION", environment);
  // A lane that publishes several manifests commits one of them last as the release marker. Only
  // that marker is immutable; the manifests published before it may be replaced so that a run
  // interrupted mid-publish can be retried at the same tag instead of stranding an architecture.
  const allowRepublish = environment.ALLOW_REPUBLISH === "true";
  const manifestUrl = new URL(updateManifest, `${publicRoot}/`);
  const response = await fetchImplementation(manifestUrl, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Could not inspect ${manifestUrl.href}: HTTP ${response.status}`);
  }

  const publishedVersion = parseManifestVersion(await response.text());
  if (publishedVersion === desktopVersion) {
    if (allowRepublish) {
      console.error(
        `${updateManifest} already publishes version ${desktopVersion}; replacing it to finish ` +
          "an interrupted release.",
      );
      return;
    }
    throw new Error(
      `${updateManifest} already publishes version ${desktopVersion}. ` +
        "Bump the version rather than replacing it.",
    );
  }
  if (!isVersionGreater(desktopVersion, publishedVersion)) {
    throw new Error(
      `Refusing to move ${updateManifest} backward from ` +
        `${publishedVersion} to ${desktopVersion}.`,
    );
  }
}

function awsEnvironment(environment) {
  return {
    ...environment,
    AWS_CONFIG_FILE: path.join(
      requireEnvironment("RUNNER_TEMP", environment),
      "hype-comms-aws-config",
    ),
    AWS_MAX_ATTEMPTS: environment.AWS_MAX_ATTEMPTS ?? "5",
    AWS_RETRY_MODE: environment.AWS_RETRY_MODE ?? "standard",
  };
}

export function runAws(arguments_, { environment = process.env, spawn = spawnSync } = {}) {
  const result = spawn("aws", arguments_, {
    env: awsEnvironment(environment),
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`aws exited with status ${result.status ?? "unknown"}`);
  }
}

export async function runAwsWithRetry(
  arguments_,
  {
    attempts = 4,
    environment = process.env,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    spawn = spawnSync,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runAws(arguments_, { environment, spawn });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      const delay = 2 ** attempt * 1_000;
      console.error(
        `AWS command attempt ${attempt} of ${attempts} failed; retrying in ${delay / 1_000}s.`,
      );
      await sleep(delay);
    }
  }
}

export function configureBucketByPath(options = {}) {
  runAws(["configure", "set", "default.s3.addressing_style", "path"], options);
}

function uploadArguments(environment, source, destination, ...arguments_) {
  return [
    "--endpoint-url",
    requireEnvironment("HYPE_COMMS_UPDATE_S3_ENDPOINT", environment),
    "s3",
    "cp",
    source,
    destination,
    ...arguments_,
    "--no-progress",
  ];
}

export async function uploadPlatformArtifacts({
  environment = process.env,
  releaseDirectory = defaultReleaseDirectory,
  spawn = spawnSync,
} = {}) {
  const desktopVersion = requireEnvironment("DESKTOP_VERSION", environment);
  const artifactOs = requireEnvironment("UPDATE_ARTIFACT_OS", environment);
  const bucket = requireEnvironment("HYPE_COMMS_UPDATE_S3_BUCKET", environment);
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const artifactNames = selectArtifactNames(entries, desktopVersion, artifactOs);

  if (artifactNames.length === 0) {
    throw new Error(`No ${artifactOs} artifacts were produced for ${desktopVersion}.`);
  }

  for (const artifactName of artifactNames) {
    await runAwsWithRetry(
      uploadArguments(
        environment,
        path.join(releaseDirectory, artifactName),
        `s3://${bucket}/desktop/${artifactName}`,
        "--cache-control",
        "public, max-age=31536000, immutable",
      ),
      { environment, spawn },
    );
  }
}

export async function uploadPlatformManifest({
  environment = process.env,
  releaseDirectory = defaultReleaseDirectory,
  spawn = spawnSync,
} = {}) {
  const updateManifest = requireEnvironment("UPDATE_MANIFEST", environment);
  const desktopVersion = requireEnvironment("DESKTOP_VERSION", environment);
  const bucket = requireEnvironment("HYPE_COMMS_UPDATE_S3_BUCKET", environment);
  const manifestPath = path.join(releaseDirectory, updateManifest);
  const manifestVersion = parseManifestVersion(await readFile(manifestPath, "utf8"));

  if (manifestVersion !== desktopVersion) {
    throw new Error(`${updateManifest} contains ${manifestVersion}, expected ${desktopVersion}.`);
  }

  await runAwsWithRetry(
    uploadArguments(
      environment,
      manifestPath,
      `s3://${bucket}/desktop/${updateManifest}`,
      "--cache-control",
      "no-cache",
      "--content-type",
      "application/yaml",
    ),
    { environment, spawn },
  );
}

export async function publishDownloadPage({
  environment = process.env,
  source = path.join("downloads", "index.html"),
  spawn = spawnSync,
} = {}) {
  const bucket = requireEnvironment("HYPE_COMMS_UPDATE_S3_BUCKET", environment);
  await runAwsWithRetry(
    uploadArguments(
      environment,
      source,
      `s3://${bucket}/index.html`,
      "--cache-control",
      "no-cache",
      "--content-type",
      "text/html; charset=utf-8",
    ),
    { environment, spawn },
  );
}
