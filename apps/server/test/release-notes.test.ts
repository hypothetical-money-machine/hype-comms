import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageBodySchema } from "@hype-comms/contracts";
import { loadReleaseNoteBulletins } from "../src/modules/system-channels/release-notes.js";

describe("loadReleaseNoteBulletins", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-notes-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function directoryUrl(): URL {
    return pathToFileURL(`${directory}/`);
  }

  it("orders releases numerically and stamps each bulletin with its version", async () => {
    await writeFile(path.join(directory, "v0.1.2.md"), "## Highlights\n\n- Second\n");
    await writeFile(path.join(directory, "v0.1.10.md"), "## Highlights\n\n- Tenth\n");
    await writeFile(path.join(directory, "v0.2.0.md"), "## Highlights\n\n- Later\n");
    await writeFile(path.join(directory, "v0.1.1.md"), "## Highlights\n\n- First\n");

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());

    // Oldest first, and 0.1.10 sorts after 0.1.2 rather than lexicographically before it.
    expect(bulletins.map((bulletin) => bulletin.key)).toEqual([
      "v0.1.1",
      "v0.1.2",
      "v0.1.10",
      "v0.2.0",
    ]);
    expect(bulletins[0]?.body).toBe("**Hype Comms v0.1.1**\n\n## Highlights\n\n- First");
  });

  it("skips unreviewed, empty, and non-release files", async () => {
    await writeFile(
      path.join(directory, "v0.1.1.md"),
      "<!-- release-notes:todo Remove this line. -->\n\n## Highlights\n\n- Unreviewed\n",
    );
    await writeFile(path.join(directory, "v0.1.2.md"), "   \n");
    await writeFile(path.join(directory, "README.md"), "## Highlights\n\n- Not a release\n");
    await writeFile(path.join(directory, "v0.1.3-beta.md"), "## Highlights\n\n- Prerelease\n");
    await writeFile(path.join(directory, "v0.1.4.md"), "## Highlights\n\n- Shipped\n");

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());

    expect(bulletins.map((bulletin) => bulletin.key)).toEqual(["v0.1.4"]);
  });

  it("truncates an oversized release note to a body the contract accepts", async () => {
    await writeFile(path.join(directory, "v0.1.1.md"), `## Highlights\n\n- ${"x".repeat(5_000)}\n`);

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());
    const body = bulletins[0]?.body ?? "";

    expect(body.length).toBeLessThanOrEqual(4_000);
    expect(body).toContain("_Full notes: docs/releases/v0.1.1.md_");
  });

  it("truncates by UTF-16 code units so an emoji-heavy note still satisfies the contract", async () => {
    // 2,500 code points but 5,000 UTF-16 units: a code-point cap would let this through and
    // messageBodySchema would then reject it, aborting the whole seeding pass.
    await writeFile(
      path.join(directory, "v0.1.2.md"),
      `## Highlights\n\n- ${"🎉".repeat(2_500)}\n`,
    );

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());
    const body = bulletins[0]?.body ?? "";

    expect(body.length).toBeLessThanOrEqual(4_000);
    expect(messageBodySchema.safeParse(body).success).toBe(true);
    // No surrogate pair was split at the cut.
    expect(body).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(body).toContain("_Full notes: docs/releases/v0.1.2.md_");
  });

  it("reads the notes bundled with the server when no directory is given", async () => {
    // Exercises the module-relative fallback used under tsx in development.
    const bulletins = await loadReleaseNoteBulletins();

    expect(bulletins.length).toBeGreaterThan(0);
    for (const bulletin of bulletins) {
      expect(bulletin.key).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(bulletin.body.length).toBeLessThanOrEqual(4_000);
    }
  });
});
