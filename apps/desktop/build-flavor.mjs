export const DESKTOP_BUILD_FLAVOR_ENV = "HYPE_COMMS_BUILD_FLAVOR";

export const DEVELOPMENT_DESKTOP_BUILD_FLAVOR = Object.freeze({
  name: "development",
  isProduction: false,
  packageName: "hype-comms-dev",
  appId: "com.hypemm.hypecomms.dev",
  productName: "Hype Comms DEV",
  executableName: "hype-comms-dev",
  artifactName: "hype-comms-dev-${version}-${os}-${arch}.${ext}",
  desktopName: "hype-comms-dev",
  linuxPackageName: "hype-comms-dev",
  protocolScheme: "hype-comms-dev",
  releaseDirectory: "release/dev",
  updateUrl: null,
});

export const PRODUCTION_DESKTOP_BUILD_FLAVOR = Object.freeze({
  name: "production",
  isProduction: true,
  packageName: "@hype-comms/desktop",
  appId: "com.hypemm.hypecomms",
  productName: "Hype Comms",
  executableName: "hype-comms",
  artifactName: "hype-comms-${version}-${os}-${arch}.${ext}",
  desktopName: "com.hypemm.hypecomms.desktop",
  linuxPackageName: "hype-comms",
  protocolScheme: "hype-comms",
  releaseDirectory: "release",
  updateUrl: "https://updates.hypemm.com/desktop",
});

export function resolveDesktopBuildFlavor(value = process.env[DESKTOP_BUILD_FLAVOR_ENV]) {
  if (value === undefined || value === DEVELOPMENT_DESKTOP_BUILD_FLAVOR.name) {
    return DEVELOPMENT_DESKTOP_BUILD_FLAVOR;
  }
  if (value === PRODUCTION_DESKTOP_BUILD_FLAVOR.name) {
    return PRODUCTION_DESKTOP_BUILD_FLAVOR;
  }

  throw new Error(
    `${DESKTOP_BUILD_FLAVOR_ENV} must be "development" or "production"; received ${JSON.stringify(value)}`,
  );
}
