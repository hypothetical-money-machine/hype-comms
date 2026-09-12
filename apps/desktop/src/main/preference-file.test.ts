import { constants, open, readFile, rename, symlink, writeFile } from "node:fs/promises";

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  JsonPreferenceFile,
  readPrivateBoundedUtf8File,
  type PrivateReadableFileHandle,
} from "./preference-file";
import { createTemporaryDirectory } from "./test-support/temporary-directory";

describe("JSON preference persistence", () => {
  it("rejects an oversized Unicode write without replacing the last durable value", async () => {
    const filePath = path.join(
      await createTemporaryDirectory("hype-comms-preference-limit-"),
      "value.json",
    );
    const file = new JsonPreferenceFile({
      filePath,
      maxBytes: 32,
      defaultValue: "",
      codec: {
        decode: (value) => (typeof value === "string" ? value : null),
        encode: (value: string) => value,
      },
    });
    await file.save("saved");
    await expect(file.save("😀".repeat(10))).rejects.toThrow("file size limit");
    expect(await readFile(filePath, "utf8")).toBe('"saved"\n');
    await file.save("next");
    await expect(file.load()).resolves.toBe("next");
  });

  it("captures an accepted write before the caller mutates its value", async () => {
    const filePath = path.join(
      await createTemporaryDirectory("hype-comms-preference-snapshot-"),
      "value.json",
    );
    const file = new JsonPreferenceFile<string[]>({
      filePath,
      maxBytes: 128,
      defaultValue: [],
      codec: {
        decode: (value) =>
          Array.isArray(value) && value.every((item): item is string => typeof item === "string")
            ? value
            : null,
        encode: (value) => value,
      },
    });
    const value = ["accepted"];
    const saved = file.save(value);
    value.push("later edit");
    await saved;
    await expect(file.load()).resolves.toEqual(["accepted"]);
  });
});

describe("private preference file reads", () => {
  it("keeps reading the opened inode when the pathname is replaced after fstat", async () => {
    const directory = await createTemporaryDirectory("hype-comms-private-read-");
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
    const directory = await createTemporaryDirectory("hype-comms-private-read-");
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
