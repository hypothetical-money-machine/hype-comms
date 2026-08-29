import type { ChildProcess as ChildProcessInstance, SpawnOptions } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { lstatSync, readdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  afterSpawn: undefined as ((child: ChildProcessInstance) => void) | undefined,
  beforeSpawn: undefined as (() => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
      race.beforeSpawn?.();
      const child = actual.spawn(command, args, options);
      race.afterSpawn?.(child);
      return child;
    },
  };
});

import { savePrivateDownload } from "../src/commands/files.js";

async function directory(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), "hype-comms-cli-files-race-"));
}

function replaceWithSymlink(
  checkedDirectory: string,
  movedDirectory: string,
  attackerDirectory: string,
): void {
  renameSync(checkedDirectory, movedDirectory);
  symlinkSync(attackerDirectory, checkedDirectory);
}

function restoreDirectory(checkedDirectory: string, movedDirectory: string): void {
  unlinkSync(checkedDirectory);
  renameSync(movedDirectory, checkedDirectory);
}

function isWorkerPhase(message: unknown, phase: string): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "phase" &&
    "phase" in message &&
    message.phase === phase
  );
}

afterEach(() => {
  race.afterSpawn = undefined;
  race.beforeSpawn = undefined;
});

describe("private attachment publication under directory replacement", () => {
  it("does not expose a path supplied by the worker in a failure message", async () => {
    const cwd = await directory();
    const suppliedPath = "/private/example/should-not-be-exposed";

    race.afterSpawn = (child) => {
      race.afterSpawn = undefined;
      queueMicrotask(() => {
        child.emit("message", {
          type: "result",
          ok: false,
          code: "INVALID_OUTPUT_PATH",
          message: suppliedPath,
        });
        child.kill();
      });
    };

    await expect(
      savePrivateDownload(cwd, "download.bin", new TextEncoder().encode("private attachment")),
    ).rejects.toMatchObject({
      code: "INVALID_OUTPUT_PATH",
      message: "The output directory changed while the file was being saved",
    });
  });

  it("does not write through a parent replaced after validation but before worker startup", async () => {
    const cwd = await directory();
    const checkedDirectory = join(cwd, "checked");
    const movedDirectory = join(cwd, "checked-before-swap");
    const attackerDirectory = join(cwd, "attacker");
    await mkdir(checkedDirectory);
    await mkdir(attackerDirectory);

    race.beforeSpawn = () => {
      race.beforeSpawn = undefined;
      replaceWithSymlink(checkedDirectory, movedDirectory, attackerDirectory);
    };

    await expect(
      savePrivateDownload(
        cwd,
        "checked/download.bin",
        new TextEncoder().encode("private attachment"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT_PATH" });
    await expect(lstat(join(attackerDirectory, "download.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(movedDirectory, "download.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(attackerDirectory)).toEqual([]);
    expect(await readdir(movedDirectory)).toEqual([]);
  });

  it("anchors and removes the temporary file when repeated swaps begin before writing", async () => {
    const cwd = await directory();
    const checkedDirectory = join(cwd, "checked");
    const movedDirectory = join(cwd, "checked-before-swap");
    const attackerDirectory = join(cwd, "attacker");
    await mkdir(checkedDirectory);
    await mkdir(attackerDirectory);

    let observedTemporaryFile = false;
    race.afterSpawn = (child) => {
      race.afterSpawn = undefined;
      child.on("message", (message) => {
        if (!isWorkerPhase(message, "temporary-ready")) return;
        observedTemporaryFile = readdirSync(checkedDirectory).some(
          (entry) => entry.startsWith(".hype-comms-download.") && entry.endsWith(".part"),
        );
        for (let index = 0; index < 3; index += 1) {
          replaceWithSymlink(checkedDirectory, movedDirectory, attackerDirectory);
          restoreDirectory(checkedDirectory, movedDirectory);
        }
        replaceWithSymlink(checkedDirectory, movedDirectory, attackerDirectory);
      });
    };

    await expect(
      savePrivateDownload(
        cwd,
        "checked/download.bin",
        new TextEncoder().encode("private attachment"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT_PATH" });
    await expect(lstat(join(attackerDirectory, "download.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(movedDirectory, "download.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(observedTemporaryFile).toBe(true);
    expect(await readdir(attackerDirectory)).toEqual([]);
    expect(await readdir(movedDirectory)).toEqual([]);
  });

  it("removes both anchored links when the parent changes after atomic publication", async () => {
    const cwd = await directory();
    const checkedDirectory = join(cwd, "checked");
    const movedDirectory = join(cwd, "checked-before-swap");
    const attackerDirectory = join(cwd, "attacker");
    const target = join(checkedDirectory, "download.bin");
    await mkdir(checkedDirectory);
    await mkdir(attackerDirectory);

    let observedAtomicLinks = false;
    race.afterSpawn = (child) => {
      race.afterSpawn = undefined;
      child.on("message", (message) => {
        if (!isWorkerPhase(message, "target-linked")) return;
        const temporaryName = readdirSync(checkedDirectory).find(
          (entry) => entry.startsWith(".hype-comms-download.") && entry.endsWith(".part"),
        );
        if (temporaryName !== undefined) {
          const temporaryInfo = lstatSync(join(checkedDirectory, temporaryName), { bigint: true });
          const targetInfo = lstatSync(target, { bigint: true });
          observedAtomicLinks =
            temporaryInfo.dev === targetInfo.dev &&
            temporaryInfo.ino === targetInfo.ino &&
            temporaryInfo.nlink === 2n &&
            targetInfo.nlink === 2n;
        }
        replaceWithSymlink(checkedDirectory, movedDirectory, attackerDirectory);
      });
    };

    await expect(
      savePrivateDownload(cwd, target, new TextEncoder().encode("private attachment")),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT_PATH" });
    expect(observedAtomicLinks).toBe(true);
    expect(await readdir(attackerDirectory)).toEqual([]);
    expect(await readdir(movedDirectory)).toEqual([]);
  });
});
