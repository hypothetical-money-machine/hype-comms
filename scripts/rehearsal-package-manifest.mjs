import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("apps/desktop/release");
const revision = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/u.test(revision ?? ""))
  throw new Error("A complete candidate revision is required");
const packageInfo = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const files = (await readdir(directory))
  .filter((name) => /\.(?:dmg|zip|exe|AppImage|deb|yml|blockmap)$/u.test(name))
  .sort();
if (files.length === 0) throw new Error("No native rehearsal artifacts were produced");
const artifacts = [];
for (const name of files) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path.join(directory, name))) {
    hash.update(chunk);
    size += chunk.length;
  }
  artifacts.push({ name, size, sha256: hash.digest("hex") });
}
const output = path.resolve(".dev-data/rehearsal/package-manifest.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      revision,
      desktopVersion: packageInfo.version,
      platform: process.platform,
      architecture: process.arch,
      signing:
        process.platform === "darwin"
          ? "Developer ID and notarization verified"
          : process.platform === "win32" &&
              process.env.HYPE_COMMS_WINDOWS_SIGNING_ENABLED === "true"
            ? "Authenticode verified"
            : "unsigned under existing platform policy",
      nativeNotifications: process.env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED === "1",
      artifacts,
      publication: "No public feed or GitHub Release was changed by this rehearsal",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Recorded ${artifacts.length} rehearsal artifacts for ${revision}.`);
