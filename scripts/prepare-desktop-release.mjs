import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

const desktopManifestRelativePath = path.posix.join("apps", "desktop", "package.json");
const lockfileRelativePath = "package-lock.json";
const releaseLockRef = "refs/hype-comms/release-preparation-lock";

export const RELEASE_NOTES_REVIEW_MARKER =
  "<!-- release-notes:todo Remove this line after writing and reviewing these notes. -->";

function parseJsonObject(contents, description) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${description} must contain valid JSON.`, { cause: error });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must contain a JSON object.`);
  }
  return value;
}

function requireStableVersion(value, description) {
  if (typeof value !== "string" || semver.valid(value) !== value) {
    throw new Error(`${description} must be a canonical semantic version such as 0.1.24.`);
  }

  const parsed = semver.parse(value);
  if (parsed === null || parsed.prerelease.length > 0 || parsed.build.length > 0) {
    throw new Error(
      `${description} must be a stable version without prerelease or build metadata.`,
    );
  }
  return value;
}

async function readOptionalRegularFile(filePath, readFileImplementation, lstatImplementation) {
  let fileStats;
  try {
    fileStats = await lstatImplementation(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!fileStats.isFile()) {
    throw new Error(`${filePath} must be a regular file, not a symlink or special file.`);
  }
  return readFileImplementation(filePath, "utf8");
}

function temporarySiblingPath(filePath, purpose) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.release-${purpose}-${process.pid}-${randomUUID()}.tmp`,
  );
}

async function removeTemporaryFiles(filePaths, rmImplementation) {
  const cleanupResults = await Promise.allSettled(
    [...filePaths].map((filePath) => rmImplementation(filePath, { force: true })),
  );
  return cleanupResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function temporaryFileNamePattern(destinationBaseName) {
  return new RegExp(
    `^\\.${escapeRegExp(destinationBaseName)}` +
      "\\.release-(?:new|original)-(\\d+)-" +
      "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp$",
    "u",
  );
}

async function removeAbandonedTemporaryFiles(
  destinationPaths,
  { lstatImplementation, processIsRunningImplementation, readdirImplementation, rmImplementation },
) {
  const cleanupErrors = [];
  for (const destinationPath of destinationPaths) {
    const directoryPath = path.dirname(destinationPath);
    const temporaryNamePattern = temporaryFileNamePattern(path.basename(destinationPath));
    let entries;
    try {
      entries = await readdirImplementation(directoryPath, { withFileTypes: true });
    } catch (error) {
      const directoryMissing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (!directoryMissing) cleanupErrors.push(error);
      continue;
    }
    for (const entry of entries) {
      const match = entry.name.match(temporaryNamePattern);
      if (match === null || (await processIsRunningImplementation(Number(match[1])))) continue;
      const temporaryPath = path.join(directoryPath, entry.name);
      try {
        const temporaryStats = await lstatImplementation(temporaryPath);
        if (!temporaryStats.isFile()) {
          cleanupErrors.push(
            new Error(`Refusing to remove non-regular release temporary path ${temporaryPath}.`),
          );
          continue;
        }
        await rmImplementation(temporaryPath, { force: true });
      } catch (error) {
        const disappeared =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
        if (!disappeared) cleanupErrors.push(error);
      }
    }
  }
  return cleanupErrors;
}

async function readReleaseState(projectRoot, readFileImplementation) {
  const desktopManifestPath = path.join(projectRoot, desktopManifestRelativePath);
  const lockfilePath = path.join(projectRoot, lockfileRelativePath);
  const [desktopContents, lockfileContents] = await Promise.all([
    readFileImplementation(desktopManifestPath, "utf8"),
    readFileImplementation(lockfilePath, "utf8"),
  ]);
  const desktopManifest = parseJsonObject(desktopContents, desktopManifestRelativePath);
  const lockfile = parseJsonObject(lockfileContents, lockfileRelativePath);
  const lockPackages = lockfile.packages;
  const lockDesktop =
    typeof lockPackages === "object" && lockPackages !== null && !Array.isArray(lockPackages)
      ? lockPackages["apps/desktop"]
      : undefined;

  if (typeof lockDesktop !== "object" || lockDesktop === null || Array.isArray(lockDesktop)) {
    throw new Error('package-lock.json must contain a packages["apps/desktop"] object.');
  }

  const desktopVersion = requireStableVersion(
    desktopManifest.version,
    "apps/desktop/package.json version",
  );
  const lockVersion = requireStableVersion(
    lockDesktop.version,
    'package-lock.json packages["apps/desktop"] version',
  );

  return {
    desktopContents,
    desktopManifest,
    desktopManifestPath,
    desktopVersion,
    lockDesktop,
    lockfile,
    lockfileContents,
    lockfilePath,
    lockVersion,
  };
}

export function createReleaseNotesScaffold(version) {
  const stableVersion = requireStableVersion(version, "Release version");
  return `${RELEASE_NOTES_REVIEW_MARKER}

## Highlights

- Describe the most important user-visible change in Hype Comms ${stableVersion}.

## Fixes

- Describe user-visible fixes, or remove this section if there are none.

## Known limitations

- Describe important limitations or manual actions, or remove this section if there are none.
`;
}

export async function inspectDesktopRelease({
  projectRoot = process.cwd(),
  readFileImplementation = readFile,
} = {}) {
  const state = await readReleaseState(path.resolve(projectRoot), readFileImplementation);
  if (state.desktopVersion !== state.lockVersion) {
    throw new Error(
      `Desktop manifest version ${state.desktopVersion} does not match lockfile version ` +
        `${state.lockVersion}. Retry the explicit version already present in one file first.`,
    );
  }
  const suggestedVersion = semver.inc(state.desktopVersion, "patch");
  if (suggestedVersion === null) {
    throw new Error(`Could not calculate a patch after ${state.desktopVersion}.`);
  }
  return { currentVersion: state.desktopVersion, suggestedVersion };
}

function listWorktreeChanges(projectRoot) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error("Could not inspect the Git worktree.", { cause: result.error });
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(
      `Could not inspect the Git worktree (git exited ${result.status ?? "unknown"}).`,
    );
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
}

function readGitHeadFile(projectRoot, relativePath) {
  const result = spawnSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(`Could not read ${relativePath} from Git HEAD.`, { cause: result.error });
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(
      `Could not read ${relativePath} from Git HEAD (git exited ${result.status ?? "unknown"}).`,
    );
  }
  return result.stdout;
}

function readGitIndexFile(projectRoot, relativePath) {
  const result = spawnSync("git", ["show", `:${relativePath}`], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(`Could not read ${relativePath} from the Git index.`, { cause: result.error });
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(
      `Could not read ${relativePath} from the Git index (git exited ${result.status ?? "unknown"}).`,
    );
  }
  return result.stdout;
}

function gitCommand(projectRoot, args, { input } = {}) {
  return spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    input,
    shell: false,
  });
}

function gitCommandOutput(result, description) {
  if (result.error !== undefined) {
    throw new Error(description, { cause: result.error });
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`${description} (git exited ${result.status ?? "unknown"}).`);
  }
  return result.stdout.trim();
}

function readGitFileModes(projectRoot, relativePath) {
  const headOutput = gitCommandOutput(
    gitCommand(projectRoot, ["ls-tree", "HEAD", "--", relativePath]),
    `Could not read the HEAD mode for ${relativePath}`,
  );
  const indexOutput = gitCommandOutput(
    gitCommand(projectRoot, ["ls-files", "--stage", "--", relativePath]),
    `Could not read the index mode for ${relativePath}`,
  );
  const headMatch = headOutput.match(/^(\d{6})\s+blob\s+[0-9a-f]+\t/u);
  const indexMatch = indexOutput.match(/^(\d{6})\s+[0-9a-f]+\s+0\t/u);
  if (headMatch === null || indexMatch === null) {
    throw new Error(`${relativePath} must be a stage-0 file in both Git HEAD and the index.`);
  }
  return { headMode: headMatch[1], indexMode: indexMatch[1] };
}

function readGitIndexMode(projectRoot, relativePath) {
  const indexOutput = gitCommandOutput(
    gitCommand(projectRoot, ["ls-files", "--stage", "--", relativePath]),
    `Could not read the index mode for ${relativePath}`,
  );
  const indexMatch = indexOutput.match(/^(\d{6})\s+[0-9a-f]+\s+0\t/u);
  if (indexMatch === null) {
    throw new Error(`${relativePath} must be a stage-0 file in the Git index.`);
  }
  return indexMatch[1];
}

export async function acquireDesktopReleaseLock({
  processIsRunningImplementation = processIsRunning,
  projectRoot = process.cwd(),
} = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const objectFormat = gitCommandOutput(
    gitCommand(resolvedRoot, ["rev-parse", "--show-object-format"]),
    "Could not determine the Git object format",
  );
  const objectIdLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (objectIdLength === 0) {
    throw new Error(`Unsupported Git object format: ${objectFormat}`);
  }

  const ownerRecord = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    pid: process.pid,
    token: randomUUID(),
  })}\n`;
  const ownerObjectId = gitCommandOutput(
    gitCommand(resolvedRoot, ["hash-object", "-w", "--stdin"], { input: ownerRecord }),
    "Could not create the release-lock owner record",
  );
  if (!new RegExp(`^[0-9a-f]{${objectIdLength}}$`, "u").test(ownerObjectId)) {
    throw new Error("Git returned an invalid release-lock owner object ID.");
  }
  const zeroObjectId = "0".repeat(objectIdLength);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const createResult = gitCommand(resolvedRoot, [
      "update-ref",
      releaseLockRef,
      ownerObjectId,
      zeroObjectId,
    ]);
    if (createResult.status === 0) {
      let released = false;
      return {
        async release() {
          if (released) return;
          const deleteResult = gitCommand(resolvedRoot, [
            "update-ref",
            "-d",
            releaseLockRef,
            ownerObjectId,
          ]);
          if (deleteResult.error !== undefined || deleteResult.status !== 0) {
            throw new Error(
              `Release preparation finished, but ${releaseLockRef} could not be released.`,
              deleteResult.error === undefined ? undefined : { cause: deleteResult.error },
            );
          }
          released = true;
        },
      };
    }
    if (createResult.error !== undefined) {
      throw new Error("Could not acquire the release-preparation lock.", {
        cause: createResult.error,
      });
    }

    const observedObjectIdResult = gitCommand(resolvedRoot, [
      "rev-parse",
      "--verify",
      releaseLockRef,
    ]);
    if (observedObjectIdResult.status !== 0) continue;
    const observedObjectId = observedObjectIdResult.stdout.trim();
    const existingOwnerResult = gitCommand(resolvedRoot, ["cat-file", "blob", observedObjectId]);
    if (existingOwnerResult.status !== 0 || typeof existingOwnerResult.stdout !== "string") {
      throw new Error(`Existing ${releaseLockRef} has an unreadable owner record.`);
    }
    let existingOwner;
    try {
      existingOwner = JSON.parse(existingOwnerResult.stdout);
    } catch (error) {
      throw new Error(`Existing ${releaseLockRef} has an invalid owner record.`, { cause: error });
    }
    if (
      typeof existingOwner !== "object" ||
      existingOwner === null ||
      !Number.isInteger(existingOwner.pid) ||
      existingOwner.pid < 1
    ) {
      throw new Error(`Existing ${releaseLockRef} has an invalid owner record.`);
    }
    if (await processIsRunningImplementation(existingOwner.pid)) {
      throw new Error(
        `Another release preparation is already running with PID ${existingOwner.pid}.`,
      );
    }

    const removeStaleResult = gitCommand(resolvedRoot, [
      "update-ref",
      "-d",
      releaseLockRef,
      observedObjectId,
    ]);
    if (removeStaleResult.error !== undefined) {
      throw new Error("Could not remove a stale release-preparation lock.", {
        cause: removeStaleResult.error,
      });
    }
  }

  throw new Error("Could not acquire the release-preparation lock after concurrent updates.");
}

function inspectReleaseMetadata(contents, relativePath) {
  const value = parseJsonObject(contents, relativePath);
  if (relativePath === desktopManifestRelativePath) {
    const version = requireStableVersion(value.version, `${relativePath} version`);
    value.version = "<release-version>";
    return { normalized: JSON.stringify(value), version };
  }

  const packages = value.packages;
  const desktop =
    typeof packages === "object" && packages !== null && !Array.isArray(packages)
      ? packages["apps/desktop"]
      : undefined;
  if (typeof desktop !== "object" || desktop === null || Array.isArray(desktop)) {
    throw new Error(`${relativePath} must contain a packages["apps/desktop"] object.`);
  }
  const version = requireStableVersion(desktop.version, `${relativePath} desktop version`);
  desktop.version = "<release-version>";
  return { normalized: JSON.stringify(value), version };
}

async function assertFocusedReleaseWorktree({
  changes,
  processIsRunningImplementation,
  projectRoot,
  readFileImplementation,
  readGitFileModesImplementation,
  readGitIndexModeImplementation,
  readHeadFileImplementation,
  readIndexFileImplementation,
  lstatImplementation,
  targetVersion,
}) {
  const releaseOwnedPaths = [
    desktopManifestRelativePath.split(path.sep).join(path.posix.sep),
    lockfileRelativePath,
    path.posix.join("docs", "releases", `v${targetVersion}.md`),
  ];
  const allowedPaths = new Set(releaseOwnedPaths);
  const normalizedChanges = changes.map((change) =>
    typeof change === "string" ? { path: change, status: "??" } : change,
  );
  const unrelatedPaths = [];
  const activeTemporaryPaths = [];
  for (const change of normalizedChanges) {
    if (allowedPaths.has(change.path)) continue;
    let temporaryOwner;
    for (const ownedPath of releaseOwnedPaths) {
      if (path.posix.dirname(change.path) !== path.posix.dirname(ownedPath)) continue;
      const match = path.posix
        .basename(change.path)
        .match(temporaryFileNamePattern(path.posix.basename(ownedPath)));
      if (match !== null) {
        temporaryOwner = Number(match[1]);
        break;
      }
    }
    if (temporaryOwner === undefined || change.status !== "??") {
      unrelatedPaths.push(change.path);
    } else if (await processIsRunningImplementation(temporaryOwner)) {
      activeTemporaryPaths.push(change.path);
    } else {
      try {
        const temporaryStats = await lstatImplementation(path.join(projectRoot, change.path));
        if (!temporaryStats.isFile()) unrelatedPaths.push(change.path);
      } catch (error) {
        const disappeared =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
        if (!disappeared) throw error;
      }
    }
  }
  if (activeTemporaryPaths.length > 0) {
    throw new Error(
      "Another release preparation still owns temporary files. Wait for it to finish: " +
        activeTemporaryPaths.join(", "),
    );
  }
  if (unrelatedPaths.length > 0) {
    throw new Error(
      "Release preparation requires a worktree with no unrelated changes. " +
        `Commit, stash, or move these first: ${unrelatedPaths.join(", ")}`,
    );
  }

  const releaseNotesPath = releaseOwnedPaths[2];
  const releaseNotesChange = normalizedChanges.find(
    ({ path: changedPath }) => changedPath === releaseNotesPath,
  );
  if (
    releaseNotesChange !== undefined &&
    releaseNotesChange.status[0] !== " " &&
    releaseNotesChange.status[0] !== "?"
  ) {
    const indexMode = await readGitIndexModeImplementation(projectRoot, releaseNotesPath);
    if (indexMode !== "100644") {
      throw new Error(
        `${releaseNotesPath} must be a non-executable regular file in the Git index.`,
      );
    }
    const workingNotesPath = path.join(projectRoot, releaseNotesPath);
    const workingNotesStats = await lstatImplementation(workingNotesPath);
    if (!workingNotesStats.isFile() || (workingNotesStats.mode & 0o111) !== 0) {
      throw new Error(`${releaseNotesPath} must be a non-executable regular file in the worktree.`);
    }
    const [workingNotes, indexNotes] = await Promise.all([
      readFileImplementation(workingNotesPath, "utf8"),
      readIndexFileImplementation(projectRoot, releaseNotesPath),
    ]);
    if (workingNotes.replace(/\r\n/gu, "\n") !== indexNotes.replace(/\r\n/gu, "\n")) {
      throw new Error(`${releaseNotesPath} differs between the working tree and Git index.`);
    }
  }

  for (const relativePath of [desktopManifestRelativePath, lockfileRelativePath]) {
    if (!normalizedChanges.some((change) => change.path === relativePath)) continue;
    const currentPath = path.join(projectRoot, relativePath);
    const [gitModes, currentStats] = await Promise.all([
      readGitFileModesImplementation(projectRoot, relativePath),
      lstatImplementation(currentPath),
    ]);
    if (gitModes.headMode !== gitModes.indexMode) {
      throw new Error(`${relativePath} contains a staged file-mode or file-type change.`);
    }
    const headIsExecutable = gitModes.headMode === "100755";
    if (
      !["100644", "100755"].includes(gitModes.headMode) ||
      !currentStats.isFile() ||
      ((currentStats.mode & 0o111) !== 0) !== headIsExecutable
    ) {
      throw new Error(`${relativePath} contains a working-tree file-mode or file-type change.`);
    }
    const [currentContents, headContents, indexContents] = await Promise.all([
      readFileImplementation(currentPath, "utf8"),
      readHeadFileImplementation(projectRoot, relativePath),
      readIndexFileImplementation(projectRoot, relativePath),
    ]);
    const headMetadata = inspectReleaseMetadata(headContents, relativePath);
    const changedMetadata = [currentContents, indexContents].map((contents) =>
      inspectReleaseMetadata(contents, relativePath),
    );
    if (
      changedMetadata.some(
        ({ version }) => version !== headMetadata.version && version !== targetVersion,
      )
    ) {
      throw new Error(
        `${relativePath} contains a version that is neither HEAD ${headMetadata.version} nor ` +
          `the target ${targetVersion}. Finish or move that release change first.`,
      );
    }
    if (changedMetadata.some(({ normalized }) => normalized !== headMetadata.normalized)) {
      throw new Error(
        `${relativePath} contains changes besides the desktop release version. ` +
          "Commit, stash, or move them before preparing a release.",
      );
    }
  }
}

export async function prepareDesktopRelease({
  projectRoot = process.cwd(),
  targetVersion,
  chmodImplementation = chmod,
  readFileImplementation = readFile,
  lstatImplementation = lstat,
  writeFileImplementation = writeFile,
  linkImplementation = link,
  renameImplementation = rename,
  readdirImplementation = readdir,
  processIsRunningImplementation = processIsRunning,
  mkdirImplementation = mkdir,
  rmImplementation = rm,
} = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const stableTarget = requireStableVersion(targetVersion, "Target release version");
  const state = await readReleaseState(resolvedRoot, readFileImplementation);

  const notesRelativePath = path.posix.join("docs", "releases", `v${stableTarget}.md`);
  const notesPath = path.join(resolvedRoot, notesRelativePath);
  const existingNotes = await readOptionalRegularFile(
    notesPath,
    readFileImplementation,
    lstatImplementation,
  );
  if (existingNotes !== null && !/\S/u.test(existingNotes)) {
    throw new Error(
      `${notesRelativePath} exists but is empty. Add reviewed notes or remove it so the scaffold can be created.`,
    );
  }

  const versionsMatch = state.desktopVersion === state.lockVersion;
  const newerCurrentVersion = semver.gt(state.desktopVersion, state.lockVersion)
    ? state.desktopVersion
    : state.lockVersion;
  const olderCurrentVersion = semver.lt(state.desktopVersion, state.lockVersion)
    ? state.desktopVersion
    : state.lockVersion;
  if (semver.lt(stableTarget, newerCurrentVersion)) {
    throw new Error(
      `Target ${stableTarget} cannot be older than current desktop version ${newerCurrentVersion}.`,
    );
  }
  const recoveringInterruptedPreparation =
    !versionsMatch &&
    existingNotes !== null &&
    stableTarget === newerCurrentVersion &&
    semver.lt(olderCurrentVersion, stableTarget);
  if (!versionsMatch && !recoveringInterruptedPreparation) {
    throw new Error(
      `Desktop manifest version ${state.desktopVersion} does not match lockfile version ` +
        `${state.lockVersion}. Retry target ${newerCurrentVersion} with its existing release notes ` +
        "to recover an interrupted preparation.",
    );
  }

  const versionChanged =
    stableTarget !== state.desktopVersion || stableTarget !== state.lockVersion;
  if (!versionChanged && existingNotes === null) {
    throw new Error(
      `Target ${stableTarget} is already the desktop version, but ${notesRelativePath} does not ` +
        "exist. Pass a newer release version.",
    );
  }
  const nextDesktopContents = versionChanged
    ? `${JSON.stringify({ ...state.desktopManifest, version: stableTarget }, null, 2)}\n`
    : state.desktopContents;
  const nextLockfileContents = versionChanged
    ? `${JSON.stringify(
        {
          ...state.lockfile,
          packages: {
            ...state.lockfile.packages,
            "apps/desktop": { ...state.lockDesktop, version: stableTarget },
          },
        },
        null,
        2,
      )}\n`
    : state.lockfileContents;

  let desktopFileMode;
  let lockfileFileMode;
  if (versionChanged) {
    const [desktopStats, lockfileStats] = await Promise.all([
      lstatImplementation(state.desktopManifestPath),
      lstatImplementation(state.lockfilePath),
    ]);
    if (!desktopStats.isFile() || !lockfileStats.isFile()) {
      throw new Error("Desktop release metadata must use regular files.");
    }
    desktopFileMode = desktopStats.mode & 0o777;
    lockfileFileMode = lockfileStats.mode & 0o777;
  }

  const temporaryFiles = new Set();
  const stageFile = async (destinationPath, contents, fileMode) => {
    const stagedPath = temporarySiblingPath(destinationPath, "new");
    temporaryFiles.add(stagedPath);
    await writeFileImplementation(stagedPath, contents, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      ...(fileMode === undefined ? {} : { mode: fileMode }),
    });
    if (fileMode !== undefined) await chmodImplementation(stagedPath, fileMode);
    return stagedPath;
  };
  const backUpFile = async (sourcePath) => {
    const backupPath = temporarySiblingPath(sourcePath, "original");
    temporaryFiles.add(backupPath);
    await linkImplementation(sourcePath, backupPath);
    return backupPath;
  };

  const notesScaffold =
    existingNotes === null ? createReleaseNotesScaffold(stableTarget) : undefined;
  let stagedNotesPath;
  let stagedDesktopPath;
  let stagedLockfilePath;
  let desktopBackupPath;
  let lockfileBackupPath;
  let notesCreated = false;
  let desktopInstalled = false;
  let lockfileInstalled = false;
  try {
    if (existingNotes === null) {
      await mkdirImplementation(path.dirname(notesPath), { recursive: true });
      stagedNotesPath = await stageFile(notesPath, notesScaffold);
    }
    if (versionChanged) {
      stagedDesktopPath = await stageFile(
        state.desktopManifestPath,
        nextDesktopContents,
        desktopFileMode,
      );
      stagedLockfilePath = await stageFile(
        state.lockfilePath,
        nextLockfileContents,
        lockfileFileMode,
      );
      desktopBackupPath = await backUpFile(state.desktopManifestPath);
      lockfileBackupPath = await backUpFile(state.lockfilePath);
    }
    if (stagedNotesPath !== undefined) {
      await linkImplementation(stagedNotesPath, notesPath);
      notesCreated = true;
    }
    if (versionChanged) {
      await renameImplementation(stagedDesktopPath, state.desktopManifestPath);
      temporaryFiles.delete(stagedDesktopPath);
      desktopInstalled = true;
      await renameImplementation(stagedLockfilePath, state.lockfilePath);
      temporaryFiles.delete(stagedLockfilePath);
      lockfileInstalled = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    if (lockfileInstalled && lockfileBackupPath !== undefined) {
      temporaryFiles.delete(lockfileBackupPath);
      try {
        await renameImplementation(lockfileBackupPath, state.lockfilePath);
      } catch (rollbackError) {
        rollbackErrors.push(
          new Error(
            `Could not restore ${lockfileRelativePath}; original preserved at ${lockfileBackupPath}.`,
            {
              cause: rollbackError,
            },
          ),
        );
      }
    }
    if (desktopInstalled && desktopBackupPath !== undefined) {
      temporaryFiles.delete(desktopBackupPath);
      try {
        await renameImplementation(desktopBackupPath, state.desktopManifestPath);
      } catch (rollbackError) {
        rollbackErrors.push(
          new Error(
            `Could not restore ${desktopManifestRelativePath}; original preserved at ${desktopBackupPath}.`,
            { cause: rollbackError },
          ),
        );
      }
    }
    rollbackErrors.push(...(await removeTemporaryFiles(temporaryFiles, rmImplementation)));
    if (rollbackErrors.length > 0) {
      const rollbackDetail = rollbackErrors
        .map((rollbackError) =>
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        )
        .join(" ");
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Release preparation failed and could not be fully rolled back. ${rollbackDetail}`,
        { cause: error },
      );
    }
    throw error;
  }

  const cleanupErrors = await removeTemporaryFiles(temporaryFiles, rmImplementation);
  cleanupErrors.push(
    ...(await removeAbandonedTemporaryFiles(
      [notesPath, state.desktopManifestPath, state.lockfilePath],
      {
        lstatImplementation,
        processIsRunningImplementation,
        readdirImplementation,
        rmImplementation,
      },
    )),
  );
  if (cleanupErrors.length > 0) {
    const cleanupDetail = cleanupErrors
      .map((cleanupError) =>
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      )
      .join(" ");
    throw new AggregateError(
      cleanupErrors,
      `Release preparation succeeded, but temporary files could not be removed. ${cleanupDetail}`,
    );
  }

  return {
    fromVersion: versionsMatch ? state.desktopVersion : olderCurrentVersion,
    notesCreated,
    notesRelativePath,
    targetVersion: stableTarget,
    versionChanged,
  };
}

export async function runReleaseCli({
  acquireReleaseLockImplementation = acquireDesktopReleaseLock,
  args = process.argv.slice(2),
  projectRoot = process.cwd(),
  listWorktreeChangesImplementation = listWorktreeChanges,
  processIsRunningImplementation = processIsRunning,
  readGitFileModesImplementation = readGitFileModes,
  readGitIndexModeImplementation = readGitIndexMode,
  readHeadFileImplementation = readGitHeadFile,
  readIndexFileImplementation = readGitIndexFile,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout.write("Usage: npm run release -- <version>\n");
    return 0;
  }
  if (args.length === 0) {
    const release = await inspectDesktopRelease({ projectRoot });
    stderr.write(
      `A target version is required. Current: ${release.currentVersion}. ` +
        `Suggested local next patch: npm run release -- ${release.suggestedVersion}\n`,
    );
    return 1;
  }
  if (args.length !== 1) {
    throw new Error("Pass exactly one target version, for example: npm run release -- 0.1.24");
  }

  const targetVersion = requireStableVersion(args[0], "Target release version");
  const resolvedRoot = path.resolve(projectRoot);
  const releaseLock = await acquireReleaseLockImplementation({
    processIsRunningImplementation,
    projectRoot: resolvedRoot,
  });
  let result;
  try {
    await assertFocusedReleaseWorktree({
      changes: await listWorktreeChangesImplementation(resolvedRoot),
      processIsRunningImplementation,
      projectRoot: resolvedRoot,
      readFileImplementation: readFile,
      readGitFileModesImplementation,
      readGitIndexModeImplementation,
      readHeadFileImplementation,
      readIndexFileImplementation,
      lstatImplementation: lstat,
      targetVersion,
    });
    result = await prepareDesktopRelease({
      processIsRunningImplementation,
      projectRoot: resolvedRoot,
      targetVersion,
    });
  } catch (error) {
    try {
      await releaseLock.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Release preparation failed and its repository lock could not be released.",
        { cause: releaseError },
      );
    }
    throw error;
  }
  await releaseLock.release();
  const versionSummary = result.versionChanged
    ? `${result.fromVersion} -> ${result.targetVersion}`
    : `${result.targetVersion} (already prepared)`;
  stdout.write(
    [
      `Prepared Hype Comms v${result.targetVersion}.`,
      `- apps/desktop/package.json and package-lock.json: ${versionSummary}`,
      `- ${result.notesRelativePath}: ${result.notesCreated ? "created" : "preserved"}`,
      "Review the release notes, remove any remaining review marker, then run npm run check.",
      "No commit, tag, push, or release was created.",
      "",
    ].join("\n"),
  );
  return 0;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  pathToFileURL(path.resolve(executedPath)).href === import.meta.url
) {
  runReleaseCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
