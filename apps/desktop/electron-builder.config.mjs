import { resolveDesktopBuildFlavor } from "./build-flavor.mjs";

export function createElectronBuilderConfiguration(value) {
  const flavor = resolveDesktopBuildFlavor(value);

  return {
    appId: flavor.appId,
    productName: flavor.productName,
    executableName: flavor.executableName,
    artifactName: flavor.artifactName,
    asar: true,
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    npmRebuild: false,
    directories: {
      output: flavor.releaseDirectory,
    },
    publish:
      flavor.updateUrl === null
        ? null
        : [
            {
              provider: "generic",
              url: flavor.updateUrl,
            },
          ],
    ...(flavor.isProduction
      ? {}
      : {
          extraMetadata: {
            name: flavor.packageName,
            productName: flavor.productName,
            desktopName: flavor.desktopName,
          },
        }),
    files: ["dist/**/*", "package.json", "!node_modules/@anthropic-ai/claude-agent-sdk-*/**"],
    protocols: [
      {
        name: `${flavor.productName} authentication callback`,
        schemes: [flavor.protocolScheme],
      },
    ],
    mac: {
      category: "public.app-category.productivity",
      ...(flavor.isProduction
        ? { hardenedRuntime: true, notarize: true }
        : { hardenedRuntime: false, identity: "-", notarize: false }),
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      extraResources: [
        {
          from: "native-build/macos/hmm-notification-authorization.node",
          to: "hmm-notification-authorization.node",
        },
      ],
      target: [
        {
          target: "dmg",
          arch: ["x64", "arm64"],
        },
        {
          target: "zip",
          arch: ["x64", "arm64"],
        },
      ],
    },
    win: {
      target: [
        {
          target: "nsis",
          arch: ["x64", "arm64"],
        },
      ],
    },
    nsis: {
      buildUniversalInstaller: false,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
    },
    linux: {
      category: "Network;InstantMessaging",
      syncDesktopName: true,
      target: [
        {
          target: "AppImage",
          arch: ["x64", "arm64"],
        },
        {
          target: "deb",
          arch: ["x64", "arm64"],
        },
      ],
    },
    deb: {
      packageName: flavor.linuxPackageName,
    },
  };
}

export default createElectronBuilderConfiguration(process.env.HYPE_COMMS_BUILD_FLAVOR);
