const command = process.argv[2];

try {
  if (command === "validate-version") {
    const { validateReleaseVersion } = await import("./desktop-release-validation.mjs");
    await validateReleaseVersion();
  } else if (command === "configure-macos-signing" || command === "cleanup-macos-signing") {
    const { configureMacosSigning, cleanupMacosSigning } = await import("./macos-signing.mjs");
    await (command === "configure-macos-signing" ? configureMacosSigning() : cleanupMacosSigning());
  } else {
    const {
      assertVersionCanPublish,
      cacheKeyPlatformManifest,
      configureBucketByPath,
      publishDownloadPage,
      uploadPlatformArtifacts,
      uploadPlatformManifest,
    } = await import("./desktop-release-helpers.mjs");
    switch (command) {
      case "assert-unpublished":
        await assertVersionCanPublish();
        break;
      case "cache-key-manifest":
        await cacheKeyPlatformManifest();
        break;
      case "configure-s3":
        configureBucketByPath();
        break;
      case "publish-download-page":
        await publishDownloadPage();
        break;
      case "upload-artifacts":
        await uploadPlatformArtifacts();
        break;
      case "upload-manifest":
        await uploadPlatformManifest();
        break;
      default:
        throw new Error(`Unknown desktop release command: ${command ?? "(missing)"}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
