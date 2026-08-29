import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
} from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import { executeCli } from "../src/cli.js";
import { savePrivateDownload } from "../src/commands/files.js";
import { EXIT_CONTRACT, EXIT_SUCCESS, EXIT_USAGE } from "../src/errors.js";
import { CLIENT_MESSAGE_ID, CONVERSATION_ID, MESSAGE_ID, TIMESTAMP, USER_ID } from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

const ATTACHMENT_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = `hype_comms_agent_${"a".repeat(43)}`;
const FILE_CAPABILITIES = [
  ATTACHMENTS_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
].join(",");

async function directory(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), "hype-comms-cli-files-"));
}

function attachment(): Record<string, unknown> {
  return {
    id: ATTACHMENT_ID,
    messageId: MESSAGE_ID,
    uploadedBy: USER_ID,
    fileName: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    status: "ready",
    downloadUrl: null,
    createdAt: TIMESTAMP,
  };
}

function runtime(homeDirectory: string, fetch: typeof globalThis.fetch) {
  return testRuntime({
    homeDirectory,
    env: {
      HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
      HYPE_COMMS_TOKEN: TOKEN,
    },
    fetch,
  });
}

describe("safe attachment files", () => {
  it("atomically publishes a complete private file", async () => {
    const cwd = await directory();
    const target = await savePrivateDownload(cwd, "download.bin", new Uint8Array([1, 2, 3]));

    expect(target).toBe(join(cwd, "download.bin"));
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(cwd)).toEqual(["download.bin"]);
  });

  it("publishes to a valid deeply nested output path", async () => {
    const cwd = await directory();
    let nestedDirectory = cwd;
    while (join(nestedDirectory, "d", "download.bin").length <= 1_011) {
      nestedDirectory = join(nestedDirectory, "d");
      await mkdir(nestedDirectory);
    }
    const target = join(nestedDirectory, "download.bin");
    expect(target.length).toBeGreaterThan(1_000);

    await expect(
      savePrivateDownload(cwd, target, new TextEncoder().encode("deep attachment")),
    ).resolves.toBe(target);
    expect(await readFile(target, "utf8")).toBe("deep attachment");
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing file and preserves its bytes", async () => {
    const cwd = await directory();
    const target = join(cwd, "download.bin");
    await writeFile(target, "original", { mode: 0o600 });

    await expect(
      savePrivateDownload(cwd, "download.bin", new TextEncoder().encode("replacement")),
    ).rejects.toMatchObject({ exitCode: EXIT_USAGE, code: "OUTPUT_EXISTS" });
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(cwd)).toEqual(["download.bin"]);
  });

  it("refuses existing symlink destinations and symlink parent directories", async () => {
    const cwd = await directory();
    const realTarget = join(cwd, "real.bin");
    await writeFile(realTarget, "original", { mode: 0o600 });
    await symlink(realTarget, join(cwd, "link.bin"));
    await expect(savePrivateDownload(cwd, "link.bin", new Uint8Array([1]))).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
    expect(await readFile(realTarget, "utf8")).toBe("original");

    const realDirectory = await directory();
    await symlink(realDirectory, join(cwd, "linked-directory"));
    await expect(
      savePrivateDownload(cwd, "linked-directory/file.bin", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT_PATH" });
  });

  it("refuses a symlink in a nested ancestor even when the immediate parent is real", async () => {
    const cwd = await directory();
    const realDirectory = await directory();
    await mkdir(join(realDirectory, "nested"));
    await symlink(realDirectory, join(cwd, "linked-ancestor"));

    await expect(
      savePrivateDownload(
        cwd,
        "linked-ancestor/nested/file.bin",
        new TextEncoder().encode("untrusted"),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_USAGE, code: "INVALID_OUTPUT_PATH" });
    await expect(lstat(join(realDirectory, "nested", "file.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(realDirectory, "nested"))).toEqual([]);
  });

  it("lists conversation files and advertises attachments-v1", async () => {
    const homeDirectory = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe(
        `https://chat.example.test/v1/conversations/${CONVERSATION_ID}/files?limit=50`,
      );
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(FILE_CAPABILITIES);
      return jsonResponse({ files: [attachment()], nextCursor: null, hasMore: false });
    });
    const value = runtime(homeDirectory, fetch);

    expect(await executeCli(["files", "list", CONVERSATION_ID, "--json"], value)).toBe(
      EXIT_SUCCESS,
    );
    expect(JSON.parse(value.stdoutText())).toMatchObject({
      files: [{ id: ATTACHMENT_ID, messageId: MESSAGE_ID }],
    });
  });

  it("queries attachment metadata for one realtime message ID", async () => {
    const homeDirectory = await directory();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://chat.example.test/v1/attachments/query");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ messageIds: [MESSAGE_ID] });
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(FILE_CAPABILITIES);
      return jsonResponse({ attachments: [attachment()] });
    });
    const value = runtime(homeDirectory, fetch);

    expect(await executeCli(["files", "for-message", MESSAGE_ID, "--json"], value)).toBe(
      EXIT_SUCCESS,
    );
    expect(JSON.parse(value.stdoutText())).toMatchObject({
      messageId: MESSAGE_ID,
      attachments: [{ id: ATTACHMENT_ID }],
    });
  });

  it("downloads verified bytes to a private file without executing or overwriting", async () => {
    const homeDirectory = await directory();
    const bytes = new TextEncoder().encode("hello");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://chat.example.test/v1/files/${ATTACHMENT_ID}/content`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("accept-encoding")).toBe("identity");
      return new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength), "x-content-sha256": sha256 },
      });
    });
    const value = runtime(homeDirectory, fetch);

    expect(
      await executeCli(
        ["files", "get", ATTACHMENT_ID, "--output", "received.txt", "--json"],
        value,
      ),
    ).toBe(EXIT_SUCCESS);
    expect(await readFile(join(homeDirectory, "received.txt"), "utf8")).toBe("hello");
    expect((await lstat(join(homeDirectory, "received.txt"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(value.stdoutText())).toEqual({
      attachmentId: ATTACHMENT_ID,
      path: join(homeDirectory, "received.txt"),
      sizeBytes: 5,
      contentSha256: sha256,
    });
  });

  it("does not publish bytes whose digest is invalid", async () => {
    const homeDirectory = await directory();
    const bytes = new TextEncoder().encode("hello");
    const value = runtime(
      homeDirectory,
      vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(bytes, {
            headers: {
              "content-length": String(bytes.byteLength),
              "x-content-sha256": "a".repeat(64),
            },
          }),
      ),
    );

    expect(
      await executeCli(
        ["files", "get", ATTACHMENT_ID, "--output", "received.txt", "--json"],
        value,
      ),
    ).toBe(EXIT_CONTRACT);
    await expect(lstat(join(homeDirectory, "received.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("advertises attachments-v1 for history and message hydration", async () => {
    const homeDirectory = await directory();
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      expect(new Headers(init?.headers).get("x-hype-comms-capabilities")).toBe(FILE_CAPABILITIES);
      if (init?.method === "POST") {
        return jsonResponse({
          message: {
            id: MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            conversationSequence: "1",
            version: 1,
            clientMessageId: CLIENT_MESSAGE_ID,
            authorId: USER_ID,
            threadRootId: null,
            body: "hello",
            bodyFormat: "hype_comms_markdown_v1",
            editedAt: null,
            deletedAt: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          attachments: [attachment()],
          syncCursor: "1",
        });
      }
      return jsonResponse({ messages: [], attachments: [], nextCursor: null });
    });
    const historyRuntime = runtime(homeDirectory, fetch);
    const sendRuntime = runtime(homeDirectory, fetch);

    expect(
      await executeCli(["messages", "history", CONVERSATION_ID, "--json"], historyRuntime),
    ).toBe(EXIT_SUCCESS);
    expect(
      await executeCli(
        [
          "messages",
          "send",
          CONVERSATION_ID,
          "hello",
          "--client-message-id",
          CLIENT_MESSAGE_ID,
          "--json",
        ],
        sendRuntime,
      ),
    ).toBe(EXIT_SUCCESS);
    expect(paths).toEqual([
      `/v1/conversations/${CONVERSATION_ID}/messages`,
      `/v1/conversations/${CONVERSATION_ID}/messages`,
    ]);
  });
});
