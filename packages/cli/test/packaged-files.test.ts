import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const ATTACHMENT_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = `hype_comms_agent_${"a".repeat(43)}`;

it(
  "the built CLI downloads through its adjacent private-file worker",
  { timeout: 30_000 },
  async () => {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath === undefined)
      throw new Error("npm_execpath is required for the package smoke");
    await execFileAsync(
      process.execPath,
      [npmExecPath, "run", "build", "--workspace", "@hype-comms/cli"],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        maxBuffer: 2 * 1_024 * 1_024,
      },
    );

    const bytes = Buffer.from("packaged attachment bytes");
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    let authenticatedDownloadSeen = false;
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== `/v1/files/${ATTACHMENT_ID}/content`) {
        response.writeHead(404).end();
        return;
      }
      authenticatedDownloadSeen =
        request.headers.authorization === `Bearer ${TOKEN}` &&
        request.headers.accept === "application/octet-stream" &&
        request.headers["accept-encoding"] === "identity";
      response.writeHead(200, {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
        "x-content-sha256": contentSha256,
      });
      response.end(bytes);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("The package smoke server did not bind a TCP port");
    }

    const cwd = await mkdtemp(join(await realpath(tmpdir()), "hype-comms-cli-package-"));
    const target = join(cwd, "received.bin");
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          resolve(PACKAGE_DIRECTORY, "dist/bin.js"),
          "files",
          "get",
          ATTACHMENT_ID,
          "--output",
          "received.bin",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
            HYPE_COMMS_CONFIG_DIR: join(cwd, "config"),
            HYPE_COMMS_TOKEN: TOKEN,
          },
          maxBuffer: 2 * 1_024 * 1_024,
        },
      );

      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        attachmentId: ATTACHMENT_ID,
        path: target,
        sizeBytes: bytes.byteLength,
        contentSha256,
      });
      expect(authenticatedDownloadSeen).toBe(true);
      expect(await readFile(target)).toEqual(bytes);
      if (process.platform !== "win32") {
        expect((await lstat(target)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
      });
    }
  },
);
