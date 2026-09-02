import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEVELOPMENT_DESKTOP_BUILD_FLAVOR,
  PRODUCTION_DESKTOP_BUILD_FLAVOR,
  resolveDesktopBuildFlavor,
} from "../apps/desktop/build-flavor.mjs";
import { createElectronBuilderConfiguration } from "../apps/desktop/electron-builder.config.mjs";

test("defaults desktop builds to the isolated development identity", () => {
  assert.equal(resolveDesktopBuildFlavor(), DEVELOPMENT_DESKTOP_BUILD_FLAVOR);
  assert.deepEqual(DEVELOPMENT_DESKTOP_BUILD_FLAVOR, {
    name: "development",
    isProduction: false,
    packageName: "hype-comms-dev",
    appId: "com.hypemm.hypecomms.dev",
    productName: "Hype Comms DEV",
    executableName: "hype-comms-dev",
    artifactName: "hype-comms-dev-${version}-${os}-${arch}.${ext}",
    desktopName: "hype-comms-dev.desktop",
    linuxPackageName: "hype-comms-dev",
    protocolScheme: "hype-comms-dev",
    releaseDirectory: "release/dev",
    updateUrl: null,
  });
});

test("selects production only when it is explicitly requested", () => {
  assert.equal(resolveDesktopBuildFlavor("development"), DEVELOPMENT_DESKTOP_BUILD_FLAVOR);
  assert.equal(resolveDesktopBuildFlavor("production"), PRODUCTION_DESKTOP_BUILD_FLAVOR);

  for (const value of ["", "dev", "prod", "Production", "preview"]) {
    assert.throws(
      () => resolveDesktopBuildFlavor(value),
      /HYPE_COMMS_BUILD_FLAVOR must be "development" or "production"/u,
    );
  }
});

test("maps build flavors to separate native package identities", async () => {
  const development = createElectronBuilderConfiguration("development");
  const production = createElectronBuilderConfiguration("production");
  const sourcePackage = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(
    {
      appId: development.appId,
      packageName: development.extraMetadata.name,
      productName: development.productName,
      executableName: development.executableName,
      artifactName: development.artifactName,
      icon: development.icon,
      output: development.directories.output,
      desktopName: development.extraMetadata.desktopName,
      linuxPackageName: development.deb.packageName,
      protocolScheme: development.protocols[0].schemes[0],
      publish: development.publish,
    },
    {
      appId: "com.hypemm.hypecomms.dev",
      packageName: "hype-comms-dev",
      productName: "Hype Comms DEV",
      executableName: "hype-comms-dev",
      artifactName: "hype-comms-dev-${version}-${os}-${arch}.${ext}",
      icon: "build/icon.png",
      output: "release/dev",
      desktopName: "hype-comms-dev.desktop",
      linuxPackageName: "hype-comms-dev",
      protocolScheme: "hype-comms-dev",
      publish: null,
    },
  );
  assert.equal(production.extraMetadata, undefined);
  assert.deepEqual(
    {
      name: sourcePackage.name,
      productName: sourcePackage.productName,
      desktopName: sourcePackage.desktopName,
    },
    {
      name: "@hype-comms/desktop",
      productName: undefined,
      desktopName: "com.hypemm.hypecomms.desktop",
    },
  );
  assert.deepEqual(
    {
      appId: production.appId,
      productName: production.productName,
      executableName: production.executableName,
      artifactName: production.artifactName,
      icon: production.icon,
      output: production.directories.output,
      linuxPackageName: production.deb.packageName,
      protocolScheme: production.protocols[0].schemes[0],
      publish: production.publish,
    },
    {
      appId: "com.hypemm.hypecomms",
      productName: "Hype Comms",
      executableName: "hype-comms",
      artifactName: "hype-comms-${version}-${os}-${arch}.${ext}",
      icon: "build/icon.png",
      output: "release",
      linuxPackageName: "hype-comms",
      protocolScheme: "hype-comms",
      publish: [
        {
          provider: "generic",
          url: "https://updates.hypemm.com/desktop",
        },
      ],
    },
  );

  assert.deepEqual(development.electronFuses, production.electronFuses);
  assert.equal(development.mac.hardenedRuntime, false);
  assert.equal(development.mac.identity, "-");
  assert.equal(development.mac.notarize, false);
  assert.equal(production.mac.hardenedRuntime, true);
  assert.equal(production.mac.identity, undefined);
  assert.equal(production.mac.notarize, true);
  assert.equal(production.win.azureSignOptions, undefined);
  assert.equal(production.win.forceCodeSigning, undefined);
});
