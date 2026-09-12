import { spawnSync } from "node:child_process";
import { appendFile, lstat, readFile } from "node:fs/promises";
import path from "node:path";

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Release validation git ${args[0]} failed`);
  }
}

export async function validateReleaseVersion({
  environment = process.env,
  projectRoot = process.cwd(),
  runGit = git,
} = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "apps/desktop/package.json"), "utf8"),
  );
  const version = manifest.version;
  // Bound the filename before opening notes. The package version remains the tag's source of truth.
  if (
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error("The desktop package must have a release version");
  }
  if (environment.GITHUB_REF_TYPE !== "tag") throw new Error("Releases publish only from a tag");
  if (environment.GITHUB_REF_NAME !== `v${version}`)
    throw new Error("Release tag does not match the desktop version");
  if (!/^[a-f0-9]{40,64}$/u.test(environment.GITHUB_SHA ?? ""))
    throw new Error("Release commit is missing or invalid");
  const notesPath = path.join(projectRoot, "docs/releases", `v${version}.md`);
  const stat = await lstat(notesPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Release notes must be a regular file");
  const notes = await readFile(notesPath, "utf8");
  if (!/\S/u.test(notes)) throw new Error("Release notes must not be empty");
  if (notes.includes("<!-- release-notes:todo"))
    throw new Error("Release notes still require review");
  await runGit(
    ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    projectRoot,
  );
  await runGit(
    ["merge-base", "--is-ancestor", environment.GITHUB_SHA, "refs/remotes/origin/main"],
    projectRoot,
  );
  if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(environment.GITHUB_OUTPUT, `desktop-version=${version}\n`);
  return version;
}
