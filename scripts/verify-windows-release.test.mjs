import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAuthenticodeSignature,
  collectWindowsSignedArtifacts,
  excludedWindowsReleaseDirectories,
  parseAuthenticodeSignature,
  verifyWindowsRelease,
} from "./verify-windows-release.mjs";

const publisherName = "CN=Hype Comms, O=Hypothetical Money Machine, C=US";

test("production Windows verification excludes nested development artifacts", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-windows-release-"));
  try {
    const productionInstaller = path.join(releaseRoot, "hype-comms-0.1.29-win-arm64.exe");
    const productionExecutable = path.join(releaseRoot, "win-unpacked", "hype-comms.exe");
    const developmentInstaller = path.join(
      releaseRoot,
      "dev",
      "hype-comms-dev-0.1.29-win-arm64.exe",
    );
    const developmentExecutable = path.join(releaseRoot, "dev", "win-unpacked", "hype-comms.exe");
    await Promise.all([
      mkdir(path.dirname(productionExecutable), { recursive: true }),
      mkdir(path.dirname(developmentExecutable), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(productionInstaller, "installer"),
      writeFile(productionExecutable, "exe"),
      writeFile(developmentInstaller, "dev-installer"),
      writeFile(developmentExecutable, "dev-exe"),
      writeFile(path.join(releaseRoot, "hype-comms-0.1.29-win-arm64.exe.blockmap"), "blockmap"),
    ]);

    assert.deepEqual(excludedWindowsReleaseDirectories(releaseRoot), [
      path.join(releaseRoot, "dev"),
    ]);
    assert.deepEqual(
      (
        await collectWindowsSignedArtifacts(
          releaseRoot,
          excludedWindowsReleaseDirectories(releaseRoot),
        )
      ).sort(),
      [productionInstaller, productionExecutable].sort(),
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("accepts PowerShell Valid status as either the name or the enum integer", () => {
  assert.doesNotThrow(() =>
    assertAuthenticodeSignature(
      parseAuthenticodeSignature(
        JSON.stringify({
          Status: 0,
          SignerCertificate: { Subject: publisherName },
        }),
        "hype-comms.exe",
      ),
      "hype-comms.exe",
      publisherName,
    ),
  );
  assert.throws(
    () =>
      assertAuthenticodeSignature(
        { Status: "NotSigned", StatusMessage: "The file is not signed" },
        "hype-comms.exe",
        publisherName,
      ),
    /not Authenticode-valid/u,
  );
  assert.throws(
    () =>
      assertAuthenticodeSignature(
        { Status: "Valid", SignerCertificate: { Subject: "CN=Other Publisher" } },
        "hype-comms.exe",
        publisherName,
      ),
    /signed by CN=Other Publisher/u,
  );
});

test("verifies every collected installer and unpacked executable", async () => {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-windows-verify-"));
  try {
    const installer = path.join(releaseRoot, "hype-comms-0.1.29-win-x64.exe");
    const executable = path.join(releaseRoot, "win-x64-unpacked", "hype-comms.exe");
    await mkdir(path.dirname(executable), { recursive: true });
    await Promise.all([writeFile(installer, "installer"), writeFile(executable, "exe")]);

    const inspected = [];
    await verifyWindowsRelease({
      platform: "win32",
      publisherName,
      releaseDirectory: releaseRoot,
      spawnImplementation(command, args) {
        inspected.push({ command, args });
        return {
          status: 0,
          stdout: JSON.stringify({
            Status: "Valid",
            SignerCertificate: { Subject: publisherName },
          }),
          stderr: "",
        };
      },
    });

    assert.equal(inspected.length, 2);
    assert.equal(inspected[0].command, "powershell.exe");
    assert.match(inspected[0].args.join(" "), /-ExecutionPolicy Bypass/u);
    assert.match(inspected[0].args.at(-1), /Get-AuthenticodeSignature -LiteralPath/u);
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});

test("refuses to verify unsigned production Windows output", async () => {
  await assert.rejects(
    verifyWindowsRelease({
      platform: "linux",
      publisherName,
      releaseDirectory: "/tmp/unused",
    }),
    /must run on Windows/u,
  );
  await assert.rejects(
    verifyWindowsRelease({
      platform: "win32",
      publisherName: " ",
      releaseDirectory: "/tmp/unused",
    }),
    /HYPE_COMMS_WINDOWS_PUBLISHER_NAME/u,
  );

  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-windows-empty-"));
  try {
    await assert.rejects(
      verifyWindowsRelease({
        platform: "win32",
        publisherName,
        releaseDirectory: releaseRoot,
      }),
      /requires at least one NSIS installer/u,
    );
  } finally {
    await rm(releaseRoot, { recursive: true, force: true });
  }
});
