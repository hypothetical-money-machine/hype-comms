import { readdir, readFile } from "node:fs/promises";

import { messageBodySchema } from "@hype-comms/contracts";

/** Bodies are capped by `messageBodySchema` and by the messages table CHECK. */
const MAX_BULLETIN_BODY = 4_000;
const RELEASE_NOTES_FILE = /^v(\d+)\.(\d+)\.(\d+)\.md$/;
/**
 * The scaffold marker the release runbook removes once notes are written and reviewed. An
 * unreviewed file must never reach members.
 */
const REVIEW_MARKER = "release-notes:todo";

export interface SystemBulletin {
  /** Stable idempotency key for this bulletin within its channel. */
  readonly key: string;
  readonly body: string;
}

function defaultReleaseNotesDirectory(): URL {
  // Resolved against this module rather than the process working directory, matching the migration
  // runner. The build copies docs/releases to dist/release-notes, which sits two levels above this
  // compiled module; under tsx there is no dist, so fall back to the checked-in docs.
  return new URL("../../release-notes/", import.meta.url);
}

function developmentReleaseNotesDirectory(): URL {
  return new URL("../../../../../docs/releases/", import.meta.url);
}

function truncateBody(body: string, version: string): string {
  if ([...body].length <= MAX_BULLETIN_BODY) return body;
  const footer = `…\n\n_Full notes: docs/releases/v${version}.md_`;
  const room = MAX_BULLETIN_BODY - [...footer].length;
  // Slice by code point so a truncated surrogate pair cannot corrupt the body.
  return `${[...body].slice(0, room).join("").trimEnd()}${footer}`;
}

/**
 * Reads the reviewed release notes bundled with the server, oldest release first so the channel
 * timeline reads chronologically.
 *
 * The directory argument exists for tests; normal callers use the bundled notes.
 */
export async function loadReleaseNoteBulletins(
  directory?: URL,
): Promise<readonly SystemBulletin[]> {
  const resolved = directory ?? (await resolveBundledDirectory());
  if (resolved === undefined) return [];

  const entries = await readdir(resolved);
  const candidates: { version: string; order: readonly number[]; file: string }[] = [];
  for (const file of entries) {
    const match = RELEASE_NOTES_FILE.exec(file);
    if (match === null) continue;
    candidates.push({
      version: `${match[1]}.${match[2]}.${match[3]}`,
      order: [Number(match[1]), Number(match[2]), Number(match[3])],
      file,
    });
  }
  candidates.sort(
    (left, right) =>
      (left.order[0] ?? 0) - (right.order[0] ?? 0) ||
      (left.order[1] ?? 0) - (right.order[1] ?? 0) ||
      (left.order[2] ?? 0) - (right.order[2] ?? 0),
  );

  const bulletins: SystemBulletin[] = [];
  for (const candidate of candidates) {
    const raw = await readFile(new URL(candidate.file, resolved), "utf8");
    if (raw.includes(REVIEW_MARKER)) continue;
    const notes = raw.trim();
    if (notes === "") continue;
    const body = truncateBody(
      `**Hype Comms v${candidate.version}**\n\n${notes}`,
      candidate.version,
    );
    bulletins.push({ key: `v${candidate.version}`, body: messageBodySchema.parse(body) });
  }
  return bulletins;
}

async function resolveBundledDirectory(): Promise<URL | undefined> {
  for (const directory of [defaultReleaseNotesDirectory(), developmentReleaseNotesDirectory()]) {
    try {
      await readdir(directory);
      return directory;
    } catch {
      // Try the next location; a server built without notes simply seeds no bulletins.
    }
  }
  return undefined;
}
