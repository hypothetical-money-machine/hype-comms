import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requireEnvironment(name, environment) {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function releaseBodyStartsWithReviewedNotes(reviewedNotes, releaseBody) {
  if (typeof reviewedNotes !== "string" || typeof releaseBody !== "string") {
    return false;
  }
  const normalizedNotes = reviewedNotes.replace(/(?:\r?\n)+$/u, "");
  if (!/\S/u.test(normalizedNotes)) {
    return false;
  }
  return releaseBody === normalizedNotes || releaseBody.startsWith(`${normalizedNotes}\n`);
}

export async function assertGithubReleaseHasReviewedNotes({
  environment = process.env,
  readFileImplementation = readFile,
} = {}) {
  const releaseNotesPath = requireEnvironment("RELEASE_NOTES_PATH", environment);
  const releaseBodyPath = requireEnvironment("GITHUB_RELEASE_BODY_PATH", environment);
  const [reviewedNotes, releaseBody] = await Promise.all([
    readFileImplementation(releaseNotesPath, "utf8"),
    readFileImplementation(releaseBodyPath, "utf8"),
  ]);
  if (!releaseBodyStartsWithReviewedNotes(reviewedNotes, releaseBody)) {
    throw new Error("GitHub Release does not contain the reviewed release notes.");
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  try {
    await assertGithubReleaseHasReviewedNotes();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
