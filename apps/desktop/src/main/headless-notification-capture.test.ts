import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV,
  HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT,
  openHeadlessNotificationCaptureArtifact,
} from "./headless-notification-capture";

const temporaryDirectories: string[] = [];

async function privateArtifactDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hmm-headless-notifications-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "artifacts");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

function environment(directory: string): Record<string, string> {
  return {
    HMM_DESKTOP_HEADLESS: "1",
    [HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]: directory,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("openHeadlessNotificationCaptureArtifact", () => {
  it("is disabled for an ordinary desktop and rejects a leaked artifact directory", async () => {
    const directory = await privateArtifactDirectory();
    expect(
      openHeadlessNotificationCaptureArtifact({ env: {}, isPackaged: false, profile: "claire" }),
    ).toBeNull();
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: { [HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]: directory },
        isPackaged: false,
        profile: "claire",
      }),
    ).toThrow(/requires headless desktop scope/u);
  });

  it("requires an unpackaged isolated headless scope and a pinned directory", async () => {
    const directory = await privateArtifactDirectory();
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: { HMM_DESKTOP_HEADLESS: "1" },
        isPackaged: false,
        profile: "claire",
      }),
    ).toThrow(/directory is required/u);
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: environment(directory),
        isPackaged: true,
        profile: "claire",
      }),
    ).toThrow(/unpackaged isolated profile/u);
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: environment(directory),
        isPackaged: false,
        profile: "../escape",
      }),
    ).toThrow(/profile is invalid/u);
  });

  it("rejects relative, broad, linked, and non-private artifact directories", async () => {
    const directory = await privateArtifactDirectory();
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: environment("relative/artifacts"),
        isPackaged: false,
        profile: "claire",
      }),
    ).toThrow(/must be absolute/u);
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: environment(path.parse(directory).root),
        isPackaged: false,
        profile: "claire",
      }),
    ).toThrow(/allowed scope/u);

    const linked = path.join(path.dirname(directory), "linked-artifacts");
    await symlink(directory, linked, "dir");
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        env: environment(linked),
        isPackaged: false,
        profile: "claire",
      }),
    ).toThrow(/directory is invalid/u);

    if (process.platform !== "win32") {
      await chmod(directory, 0o755);
      expect(() =>
        openHeadlessNotificationCaptureArtifact({
          env: environment(directory),
          isPackaged: false,
          profile: "claire",
        }),
      ).toThrow(/must be private/u);
    }
  });
});

describe("HeadlessNotificationCaptureArtifact", () => {
  it("writes only a bounded opaque ID and eligibility reason to a private file", async () => {
    const directory = await privateArtifactDirectory();
    const artifact = openHeadlessNotificationCaptureArtifact({
      env: environment(directory),
      isPackaged: false,
      profile: "claire",
    });
    if (artifact === null) throw new Error("Expected a headless capture artifact");

    expect(
      artifact.append({ version: 1, captureId: "opaque-capture-1", reason: "direct_message" }),
    ).toBe(true);
    artifact.close();

    expect(artifact.filePath).toBe(path.join(directory, "notifications-claire.jsonl"));
    expect((await stat(artifact.filePath)).mode & 0o777).toBe(0o600);
    const serialized = await readFile(artifact.filePath, "utf8");
    expect(serialized).toBe(
      `${JSON.stringify({ version: 1, captureId: "opaque-capture-1", reason: "direct_message" })}\n`,
    );
    expect(serialized).not.toContain('"messageId"');
    expect(serialized).not.toContain('"authorId"');
    expect(serialized).not.toContain('"conversationId"');
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain("private-canary");
  });

  it("strictly rejects content, target IDs, invalid reasons, and invalid opaque IDs", async () => {
    const directory = await privateArtifactDirectory();
    const artifact = openHeadlessNotificationCaptureArtifact({
      env: environment(directory),
      isPackaged: false,
      profile: "woots",
    });
    if (artifact === null) throw new Error("Expected a headless capture artifact");

    const unsafeRecords: unknown[] = [
      {
        version: 1,
        captureId: "opaque-1",
        reason: "direct_message",
        body: "private-canary",
      },
      {
        version: 1,
        captureId: "opaque-2",
        reason: "verified_mention",
        messageId: "message-private",
      },
      {
        version: 1,
        captureId: "opaque-3",
        reason: "direct_message",
        authorId: "author-private",
      },
      {
        version: 1,
        captureId: "opaque-4",
        reason: "direct_message",
        conversationId: "conversation-private",
      },
      { version: 1, captureId: "../escape", reason: "direct_message" },
      { version: 1, captureId: "opaque-5", reason: "ordinary_channel" },
    ];
    for (const record of unsafeRecords) {
      expect(() => artifact.append(record as never)).toThrow(/record is invalid/u);
    }
    artifact.close();
    expect(await readFile(artifact.filePath, "utf8")).toBe("");
  });

  it("stops at capacity and preserves that bound when reopened", async () => {
    const directory = await privateArtifactDirectory();
    const options = {
      env: environment(directory),
      isPackaged: false,
      profile: "claire",
      recordLimit: 2,
    } as const;
    const artifact = openHeadlessNotificationCaptureArtifact(options);
    if (artifact === null) throw new Error("Expected a headless capture artifact");
    expect(
      artifact.append({
        version: 1,
        captureId: "capture-00000001",
        reason: "direct_message",
      }),
    ).toBe(true);
    expect(
      artifact.append({
        version: 1,
        captureId: "capture-00000002",
        reason: "verified_mention",
      }),
    ).toBe(true);
    expect(
      artifact.append({
        version: 1,
        captureId: "capture-00000003",
        reason: "direct_message",
      }),
    ).toBe(false);
    artifact.close();

    const reopened = openHeadlessNotificationCaptureArtifact(options);
    if (reopened === null) throw new Error("Expected a reopened headless capture artifact");
    expect(
      reopened.append({
        version: 1,
        captureId: "capture-00000004",
        reason: "direct_message",
      }),
    ).toBe(false);
    reopened.close();
    expect((await readFile(reopened.filePath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("validates capacity, existing records, append mode, and closed state", async () => {
    const directory = await privateArtifactDirectory();
    const base = { env: environment(directory), isPackaged: false, profile: "claire" } as const;
    expect(() => openHeadlessNotificationCaptureArtifact({ ...base, recordLimit: 0 })).toThrow(
      /capacity is invalid/u,
    );
    expect(() =>
      openHeadlessNotificationCaptureArtifact({
        ...base,
        recordLimit: HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT + 1,
      }),
    ).toThrow(/capacity is invalid/u);

    const first = openHeadlessNotificationCaptureArtifact({ ...base, recordLimit: 3 });
    const second = openHeadlessNotificationCaptureArtifact({ ...base, recordLimit: 3 });
    if (first === null || second === null) throw new Error("Expected capture artifacts");
    first.append({ version: 1, captureId: "capture-from-first", reason: "direct_message" });
    second.append({ version: 1, captureId: "capture-from-second", reason: "verified_mention" });
    first.close();
    second.close();
    const lines = (await readFile(first.filePath, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { version: 1, captureId: "capture-from-first", reason: "direct_message" },
      { version: 1, captureId: "capture-from-second", reason: "verified_mention" },
    ]);
    expect(() =>
      first.append({ version: 1, captureId: "closed-capture-0001", reason: "direct_message" }),
    ).toThrow(/is closed/u);

    await writeFile(
      first.filePath,
      '{"version":1,"captureId":"bad","reason":"direct_message","body":"private"}\n',
    );
    expect(() => openHeadlessNotificationCaptureArtifact({ ...base, recordLimit: 3 })).toThrow(
      /record is invalid/u,
    );
  });
});
