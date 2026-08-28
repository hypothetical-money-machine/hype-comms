import { constants, mkdtemp, open, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readPrivateBoundedUtf8File, type PrivateReadableFileHandle } from "./preference-file";

describe("private preference file reads", () => {
  it("keeps reading the opened inode when the pathname is replaced after fstat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hype-comms-private-read-"));
    const filePath = path.join(directory, "configuration.json");
    const replacementPath = path.join(directory, "replacement.json");
    await writeFile(filePath, '{"source":"trusted"}\n', { mode: 0o600 });
    await writeFile(replacementPath, '{"source":"replacement"}\n', { mode: 0o600 });

    const result = await readPrivateBoundedUtf8File(filePath, 1_024, {
      currentUid: process.getuid?.(),
      openFile: async (openedPath, flags) => {
        const handle = await open(openedPath, flags);
        let pathnameReplaced = false;
        const wrapped: PrivateReadableFileHandle = {
          async stat() {
            const metadata = await handle.stat();
            if (!pathnameReplaced) {
              pathnameReplaced = true;
              await rename(replacementPath, filePath);
            }
            return metadata;
          },
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: () => handle.close(),
        };
        return wrapped;
      },
    });

    expect(result).toEqual({ status: "ok", value: '{"source":"trusted"}\n' });
  });

  it("refuses a final-component symlink and a file not owned by the current uid", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hype-comms-private-read-"));
    const filePath = path.join(directory, "configuration.json");
    const linkPath = path.join(directory, "configuration-link.json");
    await writeFile(filePath, "{}\n", { mode: 0o600 });
    await symlink(filePath, linkPath);

    await expect(readPrivateBoundedUtf8File(linkPath, 1_024)).resolves.toEqual({
      status: "invalid",
    });
    if (process.platform !== "win32" && process.getuid !== undefined) {
      await expect(
        readPrivateBoundedUtf8File(filePath, 1_024, { currentUid: process.getuid() + 1 }),
      ).resolves.toEqual({ status: "invalid" });
    }
  });

  it("opens POSIX paths read-only with no-follow semantics", async () => {
    if (process.platform === "win32") return;
    const calls: number[] = [];
    const bytes = Buffer.from("{}\n");
    let position = 0;
    const handle: PrivateReadableFileHandle = {
      stat: async () => ({
        uid: process.getuid?.() ?? -1,
        mode: 0o100600,
        size: bytes.byteLength,
        isFile: () => true,
      }),
      async read(buffer, offset, length) {
        const count = Math.min(length, bytes.byteLength - position);
        bytes.copy(buffer, offset, position, position + count);
        position += count;
        return { bytesRead: count };
      },
      close: async () => undefined,
    };

    await expect(
      readPrivateBoundedUtf8File("/private/config.json", 1_024, {
        currentUid: process.getuid?.(),
        openFile: async (_filePath, flags) => {
          calls.push(flags);
          return handle;
        },
      }),
    ).resolves.toEqual({ status: "ok", value: "{}\n" });
    expect(calls).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW]);
  });
});
