import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import semver from "semver";

const defaultReleaseDirectory = path.join("apps", "desktop", "release");

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
  const prefix = `hmm-chat-${desktopVersion}-${artifactOs}-`;
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

export async function assertVersionCanPublish({
  environment = process.env,
  fetchImplementation = fetch,
} = {}) {
  const updateManifest = requireEnvironment("UPDATE_MANIFEST", environment);
  const publicRoot = requireEnvironment("HMM_UPDATE_PUBLIC_ROOT", environment);
  const desktopVersion = requireEnvironment("DESKTOP_VERSION", environment);
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
    throw new Error(
      `${updateManifest} already publishes version ${desktopVersion}. ` +
        "Bump the version rather than replacing it.",
    );
  }
  if (!semver.gt(desktopVersion, publishedVersion)) {
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
      "hmm-chat-aws-config",
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
    requireEnvironment("HMM_UPDATE_S3_ENDPOINT", environment),
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
  const bucket = requireEnvironment("HMM_UPDATE_S3_BUCKET", environment);
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
  const bucket = requireEnvironment("HMM_UPDATE_S3_BUCKET", environment);
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
  const bucket = requireEnvironment("HMM_UPDATE_S3_BUCKET", environment);
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
