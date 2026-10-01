import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

/** Each test owns its directories, including when tests run concurrently or assertions fail. */
export async function createTemporaryDirectory(prefix = "hype-comms-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
