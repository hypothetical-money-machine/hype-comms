import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = new URL("./verify-kustomize.sh", import.meta.url);

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-kustomize-test-"));
  const sourceDirectory = path.join(directory, "source");
  const archivePath = path.join(directory, "kustomize.tar.gz");
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, "kustomize"), "#!/bin/sh\necho fixture\n");
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDirectory, "kustomize"]);
  const archive = await readFile(archivePath);
  return {
    archivePath,
    checksum: createHash("sha256").update(archive).digest("hex"),
    directory,
  };
}

test("verifies kustomize before extracting the archive", async () => {
  const fixture = await createFixture();
  const installDirectory = path.join(fixture.directory, "install");
  try {
    await execFileAsync("sh", [
      scriptPath.pathname,
      `file://${fixture.archivePath}`,
      fixture.checksum,
      installDirectory,
    ]);
    assert.equal(
      await readFile(path.join(installDirectory, "kustomize"), "utf8"),
      "#!/bin/sh\necho fixture\n",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stops on a wrong checksum before credential use or extraction", async () => {
  const fixture = await createFixture();
  const installDirectory = path.join(fixture.directory, "install");
  const credentialUseMarker = path.join(fixture.directory, "credential-used");
  try {
    await assert.rejects(
      execFileAsync("sh", [
        "-c",
        `set -e; sh "$1" "$3" "$4" "$5"; touch "$2"`,
        "test",
        scriptPath.pathname,
        credentialUseMarker,
        `file://${fixture.archivePath}`,
        "0".repeat(64),
        installDirectory,
      ]),
      /checksum mismatch/u,
    );
    await assert.rejects(readFile(path.join(installDirectory, "kustomize")), { code: "ENOENT" });
    await assert.rejects(readFile(credentialUseMarker), { code: "ENOENT" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps archive download separate from extraction", async () => {
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /curl[\s\S]*-o "\$archive_path"/u);
  assert.match(script, /tar -xzf "\$archive_path"/u);
  assert.doesNotMatch(script, /\|\s*tar/u);
});

test("runs verification before the token-backed promotion flow", async () => {
  const workflow = await readFile(new URL("../.woodpecker.yml", import.meta.url), "utf8");
  const promotion = workflow.slice(workflow.indexOf("  - name: promote-gitops"));
  const verificationIndex = promotion.indexOf("sh scripts/verify-kustomize.sh");
  const cloneIndex = promotion.indexOf("git clone");

  assert.notEqual(verificationIndex, -1);
  assert.notEqual(cloneIndex, -1);
  assert.ok(verificationIndex < cloneIndex);
  assert.match(promotion, /kustomize edit set image \$\$\{APP\}=\$\$\{REGISTRY\}/u);
  assert.doesNotMatch(promotion, /\|\s*tar|set -x/u);
});
