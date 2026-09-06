import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The built-in release-notes channel is seeded from the reviewed notes in docs/releases. tsc emits
// only JavaScript, so those Markdown files have to be copied into dist explicitly, the same way
// the SQL migrations are. The runtime image ships dist alone and the loader resolves this
// directory relative to its own module, so the notes must sit inside dist.
const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(serverRoot, "..", "..", "docs", "releases");
const destination = path.join(serverRoot, "dist", "release-notes");

if (!existsSync(source)) {
  throw new Error(`Missing release notes directory: ${source}`);
}

cpSync(source, destination, { recursive: true });
