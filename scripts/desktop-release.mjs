import {
  assertVersionCanPublish,
  cacheKeyPlatformManifest,
  configureBucketByPath,
  publishDownloadPage,
  uploadPlatformArtifacts,
  uploadPlatformManifest,
  waitForGithubReleaseAssets,
} from "./desktop-release-helpers.mjs";

const command = process.argv[2];

try {
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
    case "wait-github-assets":
      await waitForGithubReleaseAssets();
      break;
    default:
      throw new Error(`Unknown desktop release command: ${command ?? "(missing)"}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
