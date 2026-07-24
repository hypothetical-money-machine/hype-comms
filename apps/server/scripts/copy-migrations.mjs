import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tsc emits only JavaScript, so the SQL migrations have to be copied into dist explicitly. The
// runtime image ships dist alone, and the migrator resolves its directory relative to its own
// module, so the assets must sit beside the compiled migrator.
const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(serverRoot, "src", "db", "migrations");
const destination = path.join(serverRoot, "dist", "db", "migrations");

if (!existsSync(source)) {
  throw new Error(`Missing migrations directory: ${source}`);
}

cpSync(source, destination, { recursive: true });
