import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateReleaseVersion } from "./desktop-release-validation.mjs";

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "hype-release-validation-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  for (const directory of ["apps/desktop", "docs/releases", "scripts", "bin"])
    await mkdir(path.join(projectRoot, directory), { recursive: true });
  await writeFile(
    path.join(projectRoot, "apps/desktop/package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  const notes = path.join(projectRoot, "docs/releases/v1.2.3.md");
  await writeFile(notes, "Reviewed release notes.\n");
  const environment = {
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v1.2.3",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_OUTPUT: path.join(projectRoot, "output"),
  };
  return { projectRoot, environment, notes };
}

test("validates tag, notes and main ancestry before publishing its output", async (t) => {
  const fixture_ = await fixture(t);
  const commands = [];
  assert.equal(
    await validateReleaseVersion({
      ...fixture_,
      runGit: (args) => {
        commands.push(args);
      },
    }),
    "1.2.3",
  );
  assert.deepEqual(commands, [
    ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    ["merge-base", "--is-ancestor", "a".repeat(40), "refs/remotes/origin/main"],
  ]);
  assert.equal(
    await readFile(fixture_.environment.GITHUB_OUTPUT, "utf8"),
    "desktop-version=1.2.3\n",
  );
});

test("rejects branch dispatch, version mismatch and invalid notes before Git access", async (t) => {
  const f = await fixture(t);
  const runGit = () => assert.fail("invalid releases must not reach Git");
  for (const override of [
    { GITHUB_REF_TYPE: "branch" },
    { GITHUB_REF_NAME: "v1.2.4" },
    { GITHUB_SHA: "--bad" },
  ]) {
    await assert.rejects(
      validateReleaseVersion({ ...f, environment: { ...f.environment, ...override }, runGit }),
    );
  }
  for (const content of [" \n", "<!-- release-notes:todo -->\n"]) {
    await writeFile(f.notes, content);
    await assert.rejects(validateReleaseVersion({ ...f, runGit }), /notes/u);
  }
  await rm(f.notes);
  await writeFile(path.join(f.projectRoot, "outside.md"), "Reviewed");
  await symlink(path.join(f.projectRoot, "outside.md"), f.notes);
  await assert.rejects(validateReleaseVersion({ ...f, runGit }), /regular file/u);
  await rm(f.notes);
  await assert.rejects(validateReleaseVersion({ ...f, runGit }), /ENOENT/u);
  await assert.rejects(readFile(f.environment.GITHUB_OUTPUT), /ENOENT/u);
});

test("does not write output when fetch or ancestry validation fails", async (t) => {
  for (const failure of ["fetch", "merge-base"]) {
    const f = await fixture(t);
    await assert.rejects(
      validateReleaseVersion({
        ...f,
        runGit: (args) => {
          if (args[0] === failure) throw new Error("git rejected");
        },
      }),
      /git rejected/u,
    );
    await assert.rejects(readFile(f.environment.GITHUB_OUTPUT), /ENOENT/u);
  }
});

test("runs the actual dispatcher from a checkout without installed dependencies", async (t) => {
  const f = await fixture(t);
  for (const file of ["desktop-release.mjs", "desktop-release-validation.mjs"])
    await copyFile(new URL(file, import.meta.url), path.join(f.projectRoot, "scripts", file));
  const commandLog = path.join(f.projectRoot, "git-calls");
  await writeFile(
    path.join(f.projectRoot, "bin/git"),
    '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.TEST_GIT_LOG, JSON.stringify(process.argv.slice(2))+"\\n");\n',
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, ["scripts/desktop-release.mjs", "validate-version"], {
    cwd: f.projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...f.environment,
      PATH: `${path.join(f.projectRoot, "bin")}${path.delimiter}${process.env.PATH}`,
      TEST_GIT_LOG: commandLog,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(commandLog, "utf8")).trim().split("\n").length, 2);
  assert.equal(await readFile(f.environment.GITHUB_OUTPUT, "utf8"), "desktop-version=1.2.3\n");
});
