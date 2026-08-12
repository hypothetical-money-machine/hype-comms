import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_NOTES_REVIEW_MARKER,
  acquireDesktopReleaseLock,
  createReleaseNotesScaffold,
  prepareDesktopRelease,
  runReleaseCli,
} from "./prepare-desktop-release.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function createFixture({ desktopVersion = "0.1.23", lockVersion = desktopVersion } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-"));
  await mkdir(path.join(projectRoot, "apps", "desktop"), { recursive: true });
  await mkdir(path.join(projectRoot, "docs", "releases"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "apps", "desktop", "package.json"),
    json({
      name: "@hmm-chat/desktop",
      version: desktopVersion,
      description: "Keep an unrelated 0.1.23 value unchanged",
    }),
  );
  await writeFile(
    path.join(projectRoot, "package-lock.json"),
    json({
      name: "hmm-chat",
      version: "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "hmm-chat", version: "0.1.0" },
        "apps/desktop": {
          name: "@hmm-chat/desktop",
          version: lockVersion,
          description: "Keep another 0.1.23 value unchanged",
        },
      },
    }),
  );
  return projectRoot;
}

const createOutput = () => {
  let value = "";
  return {
    get value() {
      return value;
    },
    write(chunk) {
      value += chunk;
      return true;
    },
  };
};

const acquireNoopReleaseLock = async () => ({ release: async () => {} });

const runGit = (projectRoot, args) => {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const initializeGitFixture = (projectRoot) => {
  runGit(projectRoot, ["init", "--quiet"]);
  runGit(projectRoot, ["config", "user.email", "release-test@example.invalid"]);
  runGit(projectRoot, ["config", "user.name", "Release Test"]);
  runGit(projectRoot, ["add", "apps/desktop/package.json", "package-lock.json"]);
  runGit(projectRoot, ["commit", "--quiet", "-m", "test: fixture"]);
};

test("prepares only the desktop versions and a reviewed notes scaffold", async () => {
  const projectRoot = await createFixture();
  try {
    const result = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });
    const desktopContents = await readFile(
      path.join(projectRoot, "apps", "desktop", "package.json"),
      "utf8",
    );
    const lockfileContents = await readFile(path.join(projectRoot, "package-lock.json"), "utf8");
    const notes = await readFile(path.join(projectRoot, "docs", "releases", "v0.1.24.md"), "utf8");
    const desktop = JSON.parse(desktopContents);
    const lockfile = JSON.parse(lockfileContents);

    assert.deepEqual(result, {
      fromVersion: "0.1.23",
      notesCreated: true,
      notesRelativePath: "docs/releases/v0.1.24.md",
      targetVersion: "0.1.24",
      versionChanged: true,
    });
    assert.equal(desktop.version, "0.1.24");
    assert.equal(desktop.description, "Keep an unrelated 0.1.23 value unchanged");
    assert.equal(lockfile.version, "0.1.0");
    assert.equal(lockfile.packages[""].version, "0.1.0");
    assert.equal(lockfile.packages["apps/desktop"].version, "0.1.24");
    assert.equal(
      lockfile.packages["apps/desktop"].description,
      "Keep another 0.1.23 value unchanged",
    );
    assert.ok(desktopContents.endsWith("\n"));
    assert.ok(lockfileContents.endsWith("\n"));
    assert.equal(notes, createReleaseNotesScaffold("0.1.24"));
    assert.match(notes, /Hype Comms 0\.1\.24/u);
    assert.match(notes, /## Highlights/u);
    assert.match(notes, /## Fixes/u);
    assert.match(notes, /## Known limitations/u);
    assert.ok(notes.endsWith("\n"));
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test(
  "preserves release metadata permission modes during atomic replacement",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const desktopPath = path.join(projectRoot, "apps", "desktop", "package.json");
    const lockfilePath = path.join(projectRoot, "package-lock.json");
    try {
      await Promise.all([chmod(desktopPath, 0o600), chmod(lockfilePath, 0o640)]);

      await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });

      const [desktopStats, lockfileStats] = await Promise.all([
        lstat(desktopPath),
        lstat(lockfilePath),
      ]);
      assert.equal(desktopStats.mode & 0o777, 0o600);
      assert.equal(lockfileStats.mode & 0o777, 0o640);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test("keeps owned files intact when any staged write fails partway", async (t) => {
  const stagedFileMatchers = {
    "release notes": (filePath) => path.basename(filePath).startsWith(".v0.1.24.md.release-new-"),
    "desktop manifest": (filePath) =>
      path.basename(filePath).startsWith(".package.json.release-new-"),
    lockfile: (filePath) => path.basename(filePath).startsWith(".package-lock.json.release-new-"),
  };

  for (const [description, matchesStagedFile] of Object.entries(stagedFileMatchers)) {
    await t.test(description, async () => {
      const projectRoot = await createFixture();
      const desktopPath = path.join(projectRoot, "apps", "desktop", "package.json");
      const lockfilePath = path.join(projectRoot, "package-lock.json");
      const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
      try {
        const desktopBefore = await readFile(desktopPath, "utf8");
        const lockfileBefore = await readFile(lockfilePath, "utf8");
        const writeWithPersistentFailure = async (filePath, contents, options) => {
          if (matchesStagedFile(filePath)) {
            await writeFile(filePath, "{", options);
            throw Object.assign(new Error(`simulated full disk while writing ${description}`), {
              code: "ENOSPC",
            });
          }
          await writeFile(filePath, contents, options);
        };

        await assert.rejects(
          prepareDesktopRelease({
            projectRoot,
            targetVersion: "0.1.24",
            writeFileImplementation: writeWithPersistentFailure,
          }),
          /simulated full disk/u,
        );

        assert.equal(await readFile(desktopPath, "utf8"), desktopBefore);
        assert.equal(await readFile(lockfilePath, "utf8"), lockfileBefore);
        await assert.rejects(readFile(notesPath), /ENOENT/u);
        const temporaryFiles = (await readdir(projectRoot, { recursive: true })).filter(
          (filePath) => filePath.includes(".release-"),
        );
        assert.deepEqual(temporaryFiles, []);

        const retry = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });
        assert.equal(retry.versionChanged, true);
        assert.equal(retry.notesCreated, true);
      } finally {
        await rm(projectRoot, { force: true, recursive: true });
      }
    });
  }
});

test("rolls back installed files when an atomic replacement fails", async () => {
  const projectRoot = await createFixture();
  const desktopPath = path.join(projectRoot, "apps", "desktop", "package.json");
  const lockfilePath = path.join(projectRoot, "package-lock.json");
  const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
  try {
    const desktopBefore = await readFile(desktopPath, "utf8");
    const lockfileBefore = await readFile(lockfilePath, "utf8");
    const renameWithLockFailure = async (sourcePath, destinationPath) => {
      if (destinationPath === lockfilePath && path.basename(sourcePath).includes(".release-new-")) {
        throw new Error("simulated atomic replacement failure");
      }
      await rename(sourcePath, destinationPath);
    };

    await assert.rejects(
      prepareDesktopRelease({
        projectRoot,
        targetVersion: "0.1.24",
        renameImplementation: renameWithLockFailure,
      }),
      /simulated atomic replacement failure/u,
    );

    assert.equal(await readFile(desktopPath, "utf8"), desktopBefore);
    assert.equal(await readFile(lockfilePath, "utf8"), lockfileBefore);
    assert.equal(await readFile(notesPath, "utf8"), createReleaseNotesScaffold("0.1.24"));

    const retry = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });
    assert.equal(retry.versionChanged, true);
    assert.equal(retry.notesCreated, false);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("preserves notes edited before a later preparation failure", async () => {
  const projectRoot = await createFixture();
  const desktopPath = path.join(projectRoot, "apps", "desktop", "package.json");
  const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
  const reviewedNotes = "## Highlights\n\n- Reviewed while preparation was running.\n";
  try {
    const renameAfterNotesEdit = async (sourcePath, destinationPath) => {
      if (destinationPath === desktopPath && path.basename(sourcePath).includes(".release-new-")) {
        await writeFile(notesPath, reviewedNotes);
        throw new Error("simulated replacement failure after notes edit");
      }
      await rename(sourcePath, destinationPath);
    };

    await assert.rejects(
      prepareDesktopRelease({
        projectRoot,
        targetVersion: "0.1.24",
        renameImplementation: renameAfterNotesEdit,
      }),
      /simulated replacement failure after notes edit/u,
    );

    assert.equal(await readFile(notesPath, "utf8"), reviewedNotes);
    assert.equal(JSON.parse(await readFile(desktopPath, "utf8")).version, "0.1.23");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("preserves the original backup when an atomic rollback fails", async () => {
  const projectRoot = await createFixture();
  const desktopPath = path.join(projectRoot, "apps", "desktop", "package.json");
  const lockfilePath = path.join(projectRoot, "package-lock.json");
  const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
  try {
    const desktopBefore = await readFile(desktopPath, "utf8");
    const renameWithRollbackFailure = async (sourcePath, destinationPath) => {
      const sourceName = path.basename(sourcePath);
      if (destinationPath === lockfilePath && sourceName.includes(".release-new-")) {
        throw new Error("simulated atomic replacement failure");
      }
      if (destinationPath === desktopPath && sourceName.includes(".release-original-")) {
        throw new Error("simulated rollback failure");
      }
      await rename(sourcePath, destinationPath);
    };

    await assert.rejects(
      prepareDesktopRelease({
        projectRoot,
        targetVersion: "0.1.24",
        renameImplementation: renameWithRollbackFailure,
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /could not be fully rolled back/u);
        assert.match(error.message, /original preserved at .*\.release-original-/u);
        return true;
      },
    );

    const desktopDirectory = path.dirname(desktopPath);
    const backupNames = (await readdir(desktopDirectory)).filter((name) =>
      name.startsWith(".package.json.release-original-"),
    );
    assert.equal(backupNames.length, 1);
    assert.equal(
      await readFile(path.join(desktopDirectory, backupNames[0]), "utf8"),
      desktopBefore,
    );
    assert.equal(JSON.parse(await readFile(desktopPath, "utf8")).version, "0.1.24");
    assert.equal(
      JSON.parse(await readFile(lockfilePath, "utf8")).packages["apps/desktop"].version,
      "0.1.23",
    );
    assert.equal(await readFile(notesPath, "utf8"), createReleaseNotesScaffold("0.1.24"));

    const recovered = await prepareDesktopRelease({
      processIsRunningImplementation: () => false,
      projectRoot,
      targetVersion: "0.1.24",
    });
    assert.equal(recovered.fromVersion, "0.1.23");
    assert.equal(
      JSON.parse(await readFile(lockfilePath, "utf8")).packages["apps/desktop"].version,
      "0.1.24",
    );
    assert.equal(
      (await readdir(desktopDirectory)).some((name) =>
        name.startsWith(".package.json.release-original-"),
      ),
      false,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("preserves reviewed notes and makes an exact-target retry a no-op", async () => {
  const projectRoot = await createFixture();
  try {
    await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });
    const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
    const customNotes = "## Highlights\n\n- Faster conversations.\n";
    await writeFile(notesPath, customNotes);
    const desktopBefore = await readFile(
      path.join(projectRoot, "apps", "desktop", "package.json"),
      "utf8",
    );
    const lockfileBefore = await readFile(path.join(projectRoot, "package-lock.json"), "utf8");

    const result = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });

    assert.equal(result.versionChanged, false);
    assert.equal(result.notesCreated, false);
    assert.equal(await readFile(notesPath, "utf8"), customNotes);
    assert.equal(
      await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"),
      desktopBefore,
    );
    assert.equal(
      await readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
      lockfileBefore,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("recovers an interrupted version swap when the explicit target notes exist", async () => {
  const projectRoot = await createFixture({ desktopVersion: "0.1.24", lockVersion: "0.1.23" });
  const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
  const reviewedNotes = "## Fixes\n\n- Recovered release preparation.\n";
  try {
    await writeFile(notesPath, reviewedNotes);

    const result = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });

    assert.equal(result.fromVersion, "0.1.23");
    assert.equal(result.versionChanged, true);
    assert.equal(result.notesCreated, false);
    assert.equal(
      JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8")).packages[
        "apps/desktop"
      ].version,
      "0.1.24",
    );
    assert.equal(await readFile(notesPath, "utf8"), reviewedNotes);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI permits and removes abandoned transaction files after a safe retry", async () => {
  const projectRoot = await createFixture();
  const desktopRelativePath = "apps/desktop/package.json";
  const lockfileRelativePath = "package-lock.json";
  const headFiles = new Map([
    [desktopRelativePath, await readFile(path.join(projectRoot, desktopRelativePath), "utf8")],
    [lockfileRelativePath, await readFile(path.join(projectRoot, lockfileRelativePath), "utf8")],
  ]);
  const orphanPaths = [
    path.join(
      projectRoot,
      ".package-lock.json.release-original-999999-11111111-1111-1111-1111-111111111111.tmp",
    ),
    path.join(
      projectRoot,
      "apps",
      "desktop",
      ".package.json.release-new-999999-22222222-2222-2222-2222-222222222222.tmp",
    ),
    path.join(
      projectRoot,
      "docs",
      "releases",
      ".v0.1.24.md.release-new-999999-33333333-3333-3333-3333-333333333333.tmp",
    ),
  ];
  try {
    await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });
    await Promise.all(orphanPaths.map((filePath) => writeFile(filePath, "abandoned")));
    const stdout = createOutput();

    const exitCode = await runReleaseCli({
      acquireReleaseLockImplementation: acquireNoopReleaseLock,
      args: ["0.1.24"],
      listWorktreeChangesImplementation: () => [
        desktopRelativePath,
        lockfileRelativePath,
        "docs/releases/v0.1.24.md",
        ...orphanPaths.map((filePath) =>
          path.relative(projectRoot, filePath).split(path.sep).join(path.posix.sep),
        ),
      ],
      readGitFileModesImplementation: () => ({ headMode: "100644", indexMode: "100644" }),
      readHeadFileImplementation: (_root, relativePath) => headFiles.get(relativePath),
      readIndexFileImplementation: (_root, relativePath) => headFiles.get(relativePath),
      projectRoot,
      processIsRunningImplementation: () => false,
      stdout,
    });

    assert.equal(exitCode, 0);
    assert.match(stdout.value, /already prepared/u);
    for (const orphanPath of orphanPaths) {
      await assert.rejects(readFile(orphanPath), /ENOENT/u);
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("serializes release preparation with an atomic repository lock", async () => {
  const projectRoot = await createFixture();
  try {
    initializeGitFixture(projectRoot);

    const firstLock = await acquireDesktopReleaseLock({ projectRoot });
    await assert.rejects(
      acquireDesktopReleaseLock({ projectRoot }),
      /Another release preparation is already running/u,
    );
    await firstLock.release();

    const secondLock = await acquireDesktopReleaseLock({ projectRoot });
    await secondLock.release();

    const staleLock = await acquireDesktopReleaseLock({ projectRoot });
    const recoveredLock = await acquireDesktopReleaseLock({
      processIsRunningImplementation: () => false,
      projectRoot,
    });
    await assert.rejects(staleLock.release(), /could not be released/u);
    await recoveredLock.release();
    const lockLookup = spawnSync(
      "git",
      ["rev-parse", "--verify", "refs/hype-comms/release-preparation-lock"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        shell: false,
      },
    );
    assert.notEqual(lockLookup.status, 0);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("preserves notes written before the version bump", async () => {
  const projectRoot = await createFixture();
  try {
    const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
    const customNotes = "## Fixes\n\n- Restored reconnect behavior.\n";
    await writeFile(notesPath, customNotes);

    const result = await prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" });

    assert.equal(result.versionChanged, true);
    assert.equal(result.notesCreated, false);
    assert.equal(await readFile(notesPath, "utf8"), customNotes);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("rejects an existing empty notes file before changing versions", async () => {
  for (const emptyNotes of ["", " \n\t"]) {
    const projectRoot = await createFixture();
    try {
      await writeFile(path.join(projectRoot, "docs", "releases", "v0.1.24.md"), emptyNotes);

      await assert.rejects(
        prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" }),
        /exists but is empty/u,
      );
      assert.equal(
        JSON.parse(
          await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"),
        ).version,
        "0.1.23",
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }
});

test(
  "rejects a release-notes symlink before changing versions",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const notesPath = path.join(projectRoot, "docs", "releases", "v0.1.24.md");
    try {
      await writeFile(path.join(projectRoot, "outside-notes.md"), "## Outside\n");
      await symlink(path.join("..", "..", "outside-notes.md"), notesPath);

      await assert.rejects(
        prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" }),
        /must be a regular file, not a symlink or special file/u,
      );
      assert.equal(
        JSON.parse(
          await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"),
        ).version,
        "0.1.23",
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test("rejects unsafe target versions before writing", async () => {
  for (const targetVersion of ["v0.1.24", "0.1.24-beta.1", "0.1.24+build.1", "latest"]) {
    const projectRoot = await createFixture();
    try {
      await assert.rejects(
        prepareDesktopRelease({ projectRoot, targetVersion }),
        /canonical semantic version|stable version/u,
      );
      await assert.rejects(
        readFile(path.join(projectRoot, "docs", "releases", `v${targetVersion}.md`)),
        /ENOENT/u,
      );
      const desktop = JSON.parse(
        await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"),
      );
      assert.equal(desktop.version, "0.1.23");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }
});

test("rejects a downgrade or mismatched lockfile before writing", async () => {
  const downgradeRoot = await createFixture({ desktopVersion: "0.1.24" });
  const mismatchRoot = await createFixture({ desktopVersion: "0.1.23", lockVersion: "0.1.22" });
  try {
    await assert.rejects(
      prepareDesktopRelease({ projectRoot: downgradeRoot, targetVersion: "0.1.23" }),
      /cannot be older/u,
    );
    await assert.rejects(
      prepareDesktopRelease({ projectRoot: mismatchRoot, targetVersion: "0.1.24" }),
      /does not match/u,
    );
    await assert.rejects(
      readFile(path.join(downgradeRoot, "docs", "releases", "v0.1.23.md")),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(path.join(mismatchRoot, "docs", "releases", "v0.1.24.md")),
      /ENOENT/u,
    );
  } finally {
    await rm(downgradeRoot, { force: true, recursive: true });
    await rm(mismatchRoot, { force: true, recursive: true });
  }
});

test("rejects a malformed desktop lock entry before writing", async () => {
  const projectRoot = await createFixture();
  try {
    await writeFile(
      path.join(projectRoot, "package-lock.json"),
      json({ name: "hmm-chat", version: "0.1.0", lockfileVersion: 3, packages: {} }),
    );

    await assert.rejects(
      prepareDesktopRelease({ projectRoot, targetVersion: "0.1.24" }),
      /must contain a packages\["apps\/desktop"\] object/u,
    );
    await assert.rejects(
      readFile(path.join(projectRoot, "docs", "releases", "v0.1.24.md")),
      /ENOENT/u,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("does not create notes retroactively for the already-released current version", async () => {
  const projectRoot = await createFixture();
  try {
    await assert.rejects(
      prepareDesktopRelease({ projectRoot, targetVersion: "0.1.23" }),
      /already the desktop version[\s\S]*Pass a newer release version/u,
    );
    await assert.rejects(
      readFile(path.join(projectRoot, "docs", "releases", "v0.1.23.md")),
      /ENOENT/u,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("a missing target suggests the next patch without writing", async () => {
  const projectRoot = await createFixture();
  const stdout = createOutput();
  const stderr = createOutput();
  try {
    const exitCode = await runReleaseCli({ args: [], projectRoot, stderr, stdout });

    assert.equal(exitCode, 1);
    assert.equal(stdout.value, "");
    assert.match(stderr.value, /Current: 0\.1\.23/u);
    assert.match(stderr.value, /npm run release -- 0\.1\.24/u);
    await assert.rejects(
      readFile(path.join(projectRoot, "docs", "releases", "v0.1.24.md")),
      /ENOENT/u,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI prepares an explicit target and explains its local-only effects", async () => {
  const projectRoot = await createFixture();
  const stdout = createOutput();
  const stderr = createOutput();
  try {
    const exitCode = await runReleaseCli({
      acquireReleaseLockImplementation: acquireNoopReleaseLock,
      args: ["0.2.0"],
      listWorktreeChangesImplementation: () => [],
      projectRoot,
      stderr,
      stdout,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.value, "");
    assert.match(stdout.value, /Prepared Hype Comms v0\.2\.0/u);
    assert.match(stdout.value, /0\.1\.23 -> 0\.2\.0/u);
    assert.match(stdout.value, /No commit, tag, push, or release was created/u);
    assert.equal(
      JSON.parse(await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"))
        .version,
      "0.2.0",
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI rejects unrelated worktree changes before writing", async () => {
  const projectRoot = await createFixture();
  try {
    await assert.rejects(
      runReleaseCli({
        acquireReleaseLockImplementation: acquireNoopReleaseLock,
        args: ["0.1.24"],
        listWorktreeChangesImplementation: () => ["README.md"],
        projectRoot,
      }),
      /no unrelated changes[\s\S]*README\.md/u,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(projectRoot, "apps", "desktop", "package.json"), "utf8"))
        .version,
      "0.1.23",
    );
    await assert.rejects(
      readFile(path.join(projectRoot, "docs", "releases", "v0.1.24.md")),
      /ENOENT/u,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI rejects unrelated content changes inside release metadata files", async () => {
  const projectRoot = await createFixture();
  const desktopRelativePath = "apps/desktop/package.json";
  const desktopPath = path.join(projectRoot, desktopRelativePath);
  try {
    const headDesktop = await readFile(desktopPath, "utf8");
    const changedDesktop = JSON.parse(headDesktop);
    changedDesktop.description = "Unrelated existing change";
    await writeFile(desktopPath, json(changedDesktop));

    await assert.rejects(
      runReleaseCli({
        acquireReleaseLockImplementation: acquireNoopReleaseLock,
        args: ["0.1.24"],
        listWorktreeChangesImplementation: () => [desktopRelativePath],
        projectRoot,
        readGitFileModesImplementation: () => ({ headMode: "100644", indexMode: "100644" }),
        readHeadFileImplementation: (_root, relativePath) => {
          assert.equal(relativePath, desktopRelativePath);
          return headDesktop;
        },
        readIndexFileImplementation: (_root, relativePath) => {
          assert.equal(relativePath, desktopRelativePath);
          return headDesktop;
        },
      }),
      /contains changes besides the desktop release version/u,
    );
    assert.equal(JSON.parse(await readFile(desktopPath, "utf8")).version, "0.1.23");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI rejects unrelated release metadata staged in the Git index", async () => {
  const projectRoot = await createFixture();
  const desktopRelativePath = "apps/desktop/package.json";
  const desktopPath = path.join(projectRoot, desktopRelativePath);
  try {
    initializeGitFixture(projectRoot);
    const headDesktop = await readFile(desktopPath, "utf8");
    const stagedDesktop = JSON.parse(headDesktop);
    stagedDesktop.description = "Unrelated staged change";
    await writeFile(desktopPath, json(stagedDesktop));
    runGit(projectRoot, ["add", desktopRelativePath]);
    await writeFile(desktopPath, headDesktop);
    assert.match(runGit(projectRoot, ["status", "--short"]), /^MM apps\/desktop\/package\.json$/mu);

    await assert.rejects(
      runReleaseCli({
        args: ["0.1.24"],
        projectRoot,
      }),
      /contains changes besides the desktop release version/u,
    );
    assert.equal(await readFile(desktopPath, "utf8"), headDesktop);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI rejects a staged release version other than its explicit target", async () => {
  const projectRoot = await createFixture();
  const desktopRelativePath = "apps/desktop/package.json";
  const desktopPath = path.join(projectRoot, desktopRelativePath);
  try {
    initializeGitFixture(projectRoot);
    const headDesktop = await readFile(desktopPath, "utf8");
    const stagedDesktop = JSON.parse(headDesktop);
    stagedDesktop.version = "0.1.25";
    await writeFile(desktopPath, json(stagedDesktop));
    runGit(projectRoot, ["add", desktopRelativePath]);
    await writeFile(desktopPath, headDesktop);

    await assert.rejects(
      runReleaseCli({ args: ["0.1.24"], projectRoot }),
      /neither HEAD 0\.1\.23 nor the target 0\.1\.24/u,
    );
    assert.equal(await readFile(desktopPath, "utf8"), headDesktop);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("the CLI rejects staged file-mode changes and releases its lock", async () => {
  const projectRoot = await createFixture();
  const desktopRelativePath = "apps/desktop/package.json";
  try {
    initializeGitFixture(projectRoot);
    runGit(projectRoot, ["update-index", "--chmod=+x", desktopRelativePath]);

    await assert.rejects(
      runReleaseCli({ args: ["0.1.24"], projectRoot }),
      /staged file-mode or file-type change/u,
    );

    const lockAfterFailure = await acquireDesktopReleaseLock({ projectRoot });
    await lockAfterFailure.release();
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test(
  "the CLI rejects release metadata replaced by a worktree symlink",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const desktopRelativePath = "apps/desktop/package.json";
    const desktopPath = path.join(projectRoot, desktopRelativePath);
    try {
      initializeGitFixture(projectRoot);
      await rm(desktopPath);
      await symlink("/outside-release-metadata.json", desktopPath);

      await assert.rejects(
        runReleaseCli({ args: ["0.1.24"], projectRoot }),
        /contains a working-tree file-mode or file-type change/u,
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test(
  "the CLI rejects release notes staged as a symlink",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const notesRelativePath = "docs/releases/v0.1.24.md";
    try {
      initializeGitFixture(projectRoot);
      await symlink("/outside-release-notes.md", path.join(projectRoot, notesRelativePath));
      runGit(projectRoot, ["add", notesRelativePath]);

      await assert.rejects(
        runReleaseCli({ args: ["0.1.24"], projectRoot }),
        /must be a non-executable regular file in the Git index/u,
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test(
  "the CLI rejects staged regular notes replaced by a worktree symlink",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const notesRelativePath = "docs/releases/v0.1.24.md";
    const notesPath = path.join(projectRoot, notesRelativePath);
    try {
      initializeGitFixture(projectRoot);
      await writeFile(notesPath, "## Highlights\n\n- Staged notes.\n");
      runGit(projectRoot, ["add", notesRelativePath]);
      await rm(notesPath);
      await symlink("/outside-release-notes.md", notesPath);

      await assert.rejects(
        runReleaseCli({ args: ["0.1.24"], projectRoot }),
        /must be a non-executable regular file in the worktree/u,
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test("the CLI rejects active or staged release transaction files", async () => {
  const temporaryPath =
    ".package-lock.json.release-original-12345-11111111-1111-1111-1111-111111111111.tmp";
  for (const scenario of [
    {
      expected: /Another release preparation still owns temporary files/u,
      processIsRunningImplementation: () => true,
      status: "??",
    },
    {
      expected: /no unrelated changes/u,
      processIsRunningImplementation: () => false,
      status: "A ",
    },
  ]) {
    const projectRoot = await createFixture();
    try {
      await assert.rejects(
        runReleaseCli({
          acquireReleaseLockImplementation: acquireNoopReleaseLock,
          args: ["0.1.24"],
          listWorktreeChangesImplementation: () => [
            { path: temporaryPath, status: scenario.status },
          ],
          processIsRunningImplementation: scenario.processIsRunningImplementation,
          projectRoot,
        }),
        scenario.expected,
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }
});

test(
  "the CLI rejects a non-regular abandoned release transaction path",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await createFixture();
    const temporaryPath = path.join(
      projectRoot,
      ".package-lock.json.release-original-999999-11111111-1111-1111-1111-111111111111.tmp",
    );
    try {
      initializeGitFixture(projectRoot);
      await symlink("/outside-release-transaction", temporaryPath);

      await assert.rejects(
        runReleaseCli({
          args: ["0.1.24"],
          processIsRunningImplementation: () => false,
          projectRoot,
        }),
        /no unrelated changes/u,
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  },
);

test("wires the preparation command and blocks its unreviewed scaffold", async () => {
  const [rootPackageContents, workflow, readme, scriptSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("./prepare-desktop-release.mjs", import.meta.url), "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageContents);

  assert.equal(rootPackage.scripts.release, "node scripts/prepare-desktop-release.mjs");
  assert.match(workflow, /grep -Fq '<!-- release-notes:todo'/u);
  assert.match(readme, /npm run release -- <version>/u);
  assert.match(scriptSource, /spawnSync\([\s\S]*"git"[\s\S]*"status"/u);
  const lockAcquisition = scriptSource.indexOf("await acquireReleaseLockImplementation");
  const worktreeValidation = scriptSource.indexOf(
    "await assertFocusedReleaseWorktree",
    lockAcquisition,
  );
  const preparation = scriptSource.indexOf("result = await prepareDesktopRelease", lockAcquisition);
  assert.ok(lockAcquisition >= 0, "the CLI must acquire its repository lock");
  assert.ok(worktreeValidation > lockAcquisition, "worktree validation must run inside the lock");
  assert.ok(preparation > worktreeValidation, "validation must finish before writing");
  assert.ok(preparation > lockAcquisition, "the CLI must acquire its lock before writing");
  assert.doesNotMatch(scriptSource, /git commit|git tag|git push|npm version|gh /u);
  assert.ok(createReleaseNotesScaffold("0.1.24").includes(RELEASE_NOTES_REVIEW_MARKER));
});
