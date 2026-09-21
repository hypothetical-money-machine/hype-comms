import path from "node:path";
import { rm } from "node:fs/promises";

// Call only after the runner has stopped its Electron, server and PostgreSQL processes.
// Keep samples, logs, screenshots and CPU profiles available for inspection.
export async function removePerformanceRuntimeData(directory) {
  for (const name of ["postgres", "profiles", "callbacks"]) {
    await rm(path.join(directory, name), { recursive: true, force: true });
  }
}
