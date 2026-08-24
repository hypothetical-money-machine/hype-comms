import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createElectronBuilderConfiguration } from "../apps/desktop/electron-builder.config.mjs";
import { PRODUCTION_DESKTOP_BUILD_FLAVOR } from "../apps/desktop/build-flavor.mjs";
import {
  WINDOWS_SIGNING_ABSENT_MESSAGE,
  WINDOWS_SIGNING_ENV_NAMES,
  formatIncompleteWindowsSigningError,
  isWindowsPackagingRequested,
  readWindowsSigningInputs,
  resolveWindowsSigningConfiguration,
} from "../apps/desktop/windows-signing.mjs";
import {
  WINDOWS_SIGNING_ENABLED_ENV,
  configureWindowsSigningEnv,
  githubEnvAssignments,
} from "./require-windows-signing-env.mjs";

const completeSigningEnv = {
  HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: "tenant-id",
  HYPE_COMMS_WINDOWS_AZURE_CLIENT_ID: "client-id",
  HYPE_COMMS_WINDOWS_AZURE_CLIENT_SECRET: "client-secret",
  HYPE_COMMS_WINDOWS_AZURE_ENDPOINT: "https://eus.codesigning.azure.net/",
  HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME: "hype-comms",
  HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME: "hype-comms-public",
  HYPE_COMMS_WINDOWS_PUBLISHER_NAME: "CN=Hype Comms, O=Hypothetical Money Machine, C=US",
};

test("detects Windows packaging from --win without requiring a Windows host", () => {
  assert.equal(isWindowsPackagingRequested(["electron-builder", "--win"], "linux"), true);
  assert.equal(isWindowsPackagingRequested(["electron-builder", "--linux"], "win32"), false);
  assert.equal(isWindowsPackagingRequested(["electron-builder"], "win32"), true);
  assert.equal(isWindowsPackagingRequested(["electron-builder"], "linux"), false);
});

test("treats blank Windows signing inputs as missing", () => {
  assert.deepEqual(
    readWindowsSigningInputs({
      HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: " tenant-id ",
      HYPE_COMMS_WINDOWS_PUBLISHER_NAME: "   ",
    }),
    {
      present: ["HYPE_COMMS_WINDOWS_AZURE_TENANT_ID"],
      missing: WINDOWS_SIGNING_ENV_NAMES.filter(
        (name) => name !== "HYPE_COMMS_WINDOWS_AZURE_TENANT_ID",
      ),
      values: { HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: "tenant-id" },
    },
  );
});

test("leaves production Linux and development Windows packages unsigned", () => {
  assert.deepEqual(
    resolveWindowsSigningConfiguration({
      flavor: PRODUCTION_DESKTOP_BUILD_FLAVOR,
      argv: ["electron-builder", "--linux"],
      env: {},
      platform: "linux",
    }),
    { status: "disabled" },
  );
  assert.deepEqual(
    resolveWindowsSigningConfiguration({
      flavor: { isProduction: false },
      argv: ["electron-builder", "--win"],
      env: completeSigningEnv,
      platform: "linux",
    }),
    { status: "disabled" },
  );
  assert.equal(
    createElectronBuilderConfiguration("production", {
      argv: ["electron-builder", "--linux"],
      env: {},
      platform: "linux",
    }).win.azureSignOptions,
    undefined,
  );
  assert.equal(
    createElectronBuilderConfiguration("development", {
      argv: ["electron-builder", "--win"],
      env: completeSigningEnv,
      platform: "win32",
    }).win.azureSignOptions,
    undefined,
  );
});

test("leaves production Windows packaging unsigned when Azure signing inputs are absent", () => {
  assert.deepEqual(
    resolveWindowsSigningConfiguration({
      flavor: PRODUCTION_DESKTOP_BUILD_FLAVOR,
      argv: ["electron-builder", "--win"],
      env: {},
      platform: "linux",
    }),
    { status: "absent" },
  );
  assert.equal(
    createElectronBuilderConfiguration("production", {
      argv: ["electron-builder", "--win"],
      env: {},
      platform: "linux",
    }).win.azureSignOptions,
    undefined,
  );
  assert.equal(
    createElectronBuilderConfiguration("production", {
      argv: ["electron-builder", "--win"],
      env: {},
      platform: "linux",
    }).win.forceCodeSigning,
    undefined,
  );
});

test("fail-closes production Windows packaging when Azure signing inputs are incomplete", () => {
  assert.throws(
    () =>
      createElectronBuilderConfiguration("production", {
        argv: ["electron-builder", "--win"],
        env: {
          HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: "tenant-id",
        },
        platform: "linux",
      }),
    /partially configured/u,
  );
});

test("configures Azure Trusted Signing only for production Windows packaging", () => {
  const productionWindows = createElectronBuilderConfiguration("production", {
    argv: ["electron-builder", "--win", "--x64", "--arm64"],
    env: completeSigningEnv,
    platform: "linux",
  });

  assert.equal(productionWindows.win.forceCodeSigning, true);
  assert.equal(productionWindows.win.verifyUpdateCodeSignature, true);
  assert.deepEqual(productionWindows.win.azureSignOptions, {
    publisherName: completeSigningEnv.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
    endpoint: completeSigningEnv.HYPE_COMMS_WINDOWS_AZURE_ENDPOINT,
    codeSigningAccountName: completeSigningEnv.HYPE_COMMS_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME,
    certificateProfileName: completeSigningEnv.HYPE_COMMS_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME,
  });
});

test("exports Azure auth env for electron-builder without printing secrets", async () => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-windows-signing-"));
  const githubEnvPath = path.join(isolatedRoot, "github.env");
  try {
    await writeFile(githubEnvPath, "");
    const configured = configureWindowsSigningEnv({
      ...completeSigningEnv,
      GITHUB_ENV: githubEnvPath,
    });
    assert.deepEqual(configured, {
      status: "configured",
      endpoint: completeSigningEnv.HYPE_COMMS_WINDOWS_AZURE_ENDPOINT,
      publisherName: completeSigningEnv.HYPE_COMMS_WINDOWS_PUBLISHER_NAME,
    });
    assert.deepEqual(githubEnvAssignments(completeSigningEnv), {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      [WINDOWS_SIGNING_ENABLED_ENV]: "true",
      AZURE_TENANT_ID: "tenant-id",
      AZURE_CLIENT_ID: "client-id",
      AZURE_CLIENT_SECRET: "client-secret",
      ...completeSigningEnv,
    });
    assert.match(await readFile(githubEnvPath, "utf8"), /AZURE_CLIENT_SECRET=client-secret/u);
    assert.match(await readFile(githubEnvPath, "utf8"), /HYPE_COMMS_WINDOWS_SIGNING_ENABLED=true/u);

    const absentEnvPath = path.join(isolatedRoot, "absent.env");
    await writeFile(absentEnvPath, "");
    assert.deepEqual(configureWindowsSigningEnv({ GITHUB_ENV: absentEnvPath }), {
      status: "absent",
    });
    assert.equal(
      (await readFile(absentEnvPath, "utf8")).trim(),
      `${WINDOWS_SIGNING_ENABLED_ENV}=false`,
    );

    const absentResult = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./require-windows-signing-env.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(absentResult.status, 0, absentResult.stderr);
    assert.equal(absentResult.stdout.trim(), WINDOWS_SIGNING_ABSENT_MESSAGE);

    const incompleteResult = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./require-windows-signing-env.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HYPE_COMMS_WINDOWS_AZURE_TENANT_ID: "tenant-id",
        },
      },
    );
    assert.equal(incompleteResult.status, 1);
    assert.equal(
      incompleteResult.stderr.trim(),
      formatIncompleteWindowsSigningError(
        WINDOWS_SIGNING_ENV_NAMES.filter((name) => name !== "HYPE_COMMS_WINDOWS_AZURE_TENANT_ID"),
        ["HYPE_COMMS_WINDOWS_AZURE_TENANT_ID"],
      ),
    );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});
