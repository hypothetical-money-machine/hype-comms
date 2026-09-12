import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { AgentWakeAncestorStat } from "./agent-wake-configuration";
import {
  AGENT_WAKE_CONFIGURATION_ENV,
  AGENT_WAKE_CONFIGURATION_MAX_BYTES,
  AgentWakeConfigurationError,
  loadAgentWakeConfiguration,
  pinAgentWakeExecutable,
  resolveAgentWakeConfigurationPath,
  verifyAgentWakeExecutablePin,
} from "./agent-wake-configuration";

const API_ORIGIN = "https://chat.example.test";
const CLI_ENTRYPOINT = Buffer.from("#!/usr/bin/env node\n");
const temporaryDirectories = new Set<string>();

/**
 * Test-only ancestor stat that clears the group/world write bits (and nothing else) from every
 * directory's real `lstat` result before the production ancestor-pin policy sees it. This lets
 * fixtures created under `process.cwd()` pass the policy regardless of whether the checkout's own
 * ancestor directories (e.g. a group-writable worktree parent) happen to be mode 775 on this host.
 * It does not touch ownership, device, inode, or the directory/symlink type bits the policy also
 * checks, so it cannot be used to launder a genuinely untrustworthy ancestor past the check; see
 * "still rejects a group-writable ancestor whose real permissions are left unmasked by the
 * injected seam" below, which proves the production ancestor policy still rejects a genuinely
 * group-writable directory even when this helper is used to trust every other ancestor.
 */
const clearAncestorWriteBits: AgentWakeAncestorStat = async (ancestorPath) => {
  const real = await lstat(ancestorPath, { bigint: true });
  const masked: BigIntStats = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    mode: real.isDirectory() && !real.isSymbolicLink() ? real.mode & ~0o022n : real.mode,
  });
  return masked;
};

/**
 * Test-only ancestor stat that trusts every ancestor via `clearAncestorWriteBits` except one path,
 * whose real, unmasked `lstat` result passes straight through the production ancestor policy. This
 * isolates a rejection to exactly the named ancestor's own permissions, independent of whether this
 * checkout's ambient ancestors (e.g. a group-writable worktree parent) happen to be mode 775 on this
 * host.
 */
function trustedAncestorsExcept(untrustedAncestorPath: string): AgentWakeAncestorStat {
  return (ancestorPath) =>
    ancestorPath === untrustedAncestorPath
      ? lstat(ancestorPath, { bigint: true })
      : clearAncestorWriteBits(ancestorPath);
}

/**
 * Test-only wrappers that default every call in this suite to `clearAncestorWriteBits`, so
 * fixtures created under `process.cwd()` are unaffected by this checkout's own ancestor
 * permissions. Tests exercising the ancestor policy itself call the real, unwrapped exports
 * directly (see "rejects writable or symlinked executable ancestors" and the seam-safety test
 * below) so the policy is never validated against a masked stand-in.
 */
function loadConfiguration(
  options: Parameters<typeof loadAgentWakeConfiguration>[0],
): ReturnType<typeof loadAgentWakeConfiguration> {
  return loadAgentWakeConfiguration({ statAncestor: clearAncestorWriteBits, ...options });
}

function pinExecutable(
  executablePath: string,
  options: Parameters<typeof pinAgentWakeExecutable>[1] = {},
): ReturnType<typeof pinAgentWakeExecutable> {
  return pinAgentWakeExecutable(executablePath, {
    statAncestor: clearAncestorWriteBits,
    ...options,
  });
}

function verifyPin(
  pin: Parameters<typeof verifyAgentWakeExecutablePin>[0],
  options: Parameters<typeof verifyAgentWakeExecutablePin>[1] = {},
): ReturnType<typeof verifyAgentWakeExecutablePin> {
  return verifyAgentWakeExecutablePin(pin, { statAncestor: clearAncestorWriteBits, ...options });
}

afterEach(async () => {
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(prefix);
  temporaryDirectories.add(directory);
  return directory;
}

function arm64MachOExecutable(dependency = "/usr/lib/libSystem.B.dylib"): Buffer {
  const dependencyBytes = Buffer.from(`${dependency}\0`, "ascii");
  const commandBytes = Math.ceil((24 + dependencyBytes.byteLength) / 8) * 8;
  const bytes = Buffer.alloc(32 + commandBytes);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(commandBytes, 20);
  bytes.writeUInt32LE(0x0c, 32);
  bytes.writeUInt32LE(commandBytes, 36);
  bytes.writeUInt32LE(24, 40);
  dependencyBytes.copy(bytes, 56);
  return bytes;
}

function universalMachOExecutable(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcafebabe, 0);
  return bytes;
}

function arm64MachOWithCommand(commandType: number): Buffer {
  const commandBytes = 8;
  const bytes = Buffer.alloc(32 + commandBytes);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(commandBytes, 20);
  bytes.writeUInt32LE(commandType, 32);
  bytes.writeUInt32LE(commandBytes, 36);
  return bytes;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuration(
  executablePaths: {
    readonly runtime: string;
    readonly entrypoint: string;
    readonly target: string;
  } = {
    runtime: "/opt/hype/bin/node",
    entrypoint: "/opt/hype/lib/hype-comms-cli.js",
    target: "/opt/hype/bin/agent-runtime-wake-hook",
  },
  executableHashes: {
    readonly runtime: string;
    readonly entrypoint: string;
    readonly target: string;
  } = {
    runtime: sha256(arm64MachOExecutable()),
    entrypoint: sha256(CLI_ENTRYPOINT),
    target: sha256(arm64MachOExecutable()),
  },
): Record<string, unknown> {
  return {
    version: 1,
    enrollmentId: "grok-bot-pilot",
    expectedAgentUserId: "10000000-0000-4000-8000-000000000001",
    source: {
      credentialHandle: "hype-cli-grok-bot-pilot",
      runtimeExecutablePath: executablePaths.runtime,
      runtimeExecutableSha256: executableHashes.runtime,
      cliEntrypointPath: executablePaths.entrypoint,
      cliEntrypointSha256: executableHashes.entrypoint,
      profile: "grok-bot-pilot",
      apiOrigin: API_ORIGIN,
    },
    target: {
      targetHandle: "agent-runtime-primary",
      adapterId: "agent-runtime-test",
      executablePath: executablePaths.target,
      executableSha256: executableHashes.target,
      arguments: [],
    },
  };
}

async function executableConfiguration(): Promise<{
  readonly value: Record<string, unknown>;
  readonly runtimePath: string;
  readonly entrypointPath: string;
  readonly targetPath: string;
}> {
  const directory = await temporaryDirectory(
    path.join(process.cwd(), ".hype-comms-wake-executables-"),
  );
  const runtimePath = path.join(directory, "node");
  const entrypointPath = path.join(directory, "hype-comms-cli.js");
  const targetPath = path.join(directory, "agent-runtime-wake-hook");
  await Promise.all([
    writeFile(runtimePath, arm64MachOExecutable(), { mode: 0o700 }),
    writeFile(entrypointPath, CLI_ENTRYPOINT, { mode: 0o700 }),
    writeFile(targetPath, arm64MachOExecutable(), { mode: 0o700 }),
  ]);
  return {
    value: configuration({ runtime: runtimePath, entrypoint: entrypointPath, target: targetPath }),
    runtimePath,
    entrypointPath,
    targetPath,
  };
}

async function privateConfigurationFile(value: unknown): Promise<string> {
  const directory = await temporaryDirectory(path.join(tmpdir(), "hype-comms-wake-config-"));
  const file = path.join(directory, "wake.json");
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

describe("agent wake configuration", () => {
  it("is compiled and enrolled only through two explicit default-off gates", () => {
    expect(resolveAgentWakeConfigurationPath({ compiledIn: false, env: {} })).toBeNull();
    expect(resolveAgentWakeConfigurationPath({ compiledIn: true, env: {} })).toBeNull();
    expect(
      resolveAgentWakeConfigurationPath({
        compiledIn: true,
        env: { [AGENT_WAKE_CONFIGURATION_ENV]: " /private/tmp/wake.json " },
      }),
    ).toBe("/private/tmp/wake.json");
    expect(() =>
      resolveAgentWakeConfigurationPath({
        compiledIn: false,
        env: { [AGENT_WAKE_CONFIGURATION_ENV]: "/private/tmp/wake.json" },
      }),
    ).toThrowError(new AgentWakeConfigurationError("not-compiled-in"));
  });

  it("rejects relative paths, filesystem roots, and NUL pathnames", () => {
    for (const configured of ["relative/wake.json", path.parse(process.cwd()).root, "bad\0path"]) {
      expect(() =>
        resolveAgentWakeConfigurationPath({
          compiledIn: true,
          env: { [AGENT_WAKE_CONFIGURATION_ENV]: configured },
        }),
      ).toThrowError(new AgentWakeConfigurationError("configuration-invalid"));
    }
  });

  it("rejects non-canonical executable path spellings", async () => {
    const executable = await executableConfiguration();
    const value = configuration({
      runtime: path.join(path.dirname(executable.runtimePath), ".", "node"),
      entrypoint: executable.entrypointPath,
      target: executable.targetPath,
    });
    const source = value.source as Record<string, unknown>;
    source.runtimeExecutablePath = `${path.dirname(executable.runtimePath)}/../${path.basename(
      path.dirname(executable.runtimePath),
    )}/node`;
    const file = await privateConfigurationFile(value);

    await expect(
      loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it("rejects non-loopback plaintext source origins before executable validation", async () => {
    const executable = await executableConfiguration();
    const value = executable.value;
    value.source = {
      ...(value.source as object),
      apiOrigin: "http://internal.example.test",
    };
    const file = await privateConfigurationFile(value);

    await expect(
      loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it("loads one unambiguous agent, source profile, and opaque runtime adapter", async () => {
    const grokBot = await executableConfiguration();
    const grokBotEnrollmentFile = await privateConfigurationFile(grokBot.value);
    const loaded = await loadConfiguration({
      filePath: grokBotEnrollmentFile,
      expectedApiOrigin: API_ORIGIN,
    });
    expect(loaded).toMatchObject(grokBot.value);
    expect(loaded.source.runtimeExecutablePin).toMatchObject({
      configuredPath: grokBot.runtimePath,
      canonicalPath: await realpath(grokBot.runtimePath),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(loaded.source.cliEntrypointPin).toMatchObject({
      configuredPath: grokBot.entrypointPath,
      canonicalPath: await realpath(grokBot.entrypointPath),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(loaded.target.executablePin).toMatchObject({
      configuredPath: grokBot.targetPath,
      canonicalPath: await realpath(grokBot.targetPath),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const custom = await executableConfiguration();
    const customRuntime = custom.value;
    customRuntime.target = {
      ...(customRuntime.target as object),
      targetHandle: "custom-runtime-primary",
      adapterId: "custom-runtime-v2",
    };
    const customRuntimeFile = await privateConfigurationFile(customRuntime);
    await expect(
      loadConfiguration({ filePath: customRuntimeFile, expectedApiOrigin: API_ORIGIN }),
    ).resolves.toMatchObject({
      target: { adapterId: "custom-runtime-v2", arguments: [] },
    });
  });

  it("rejects source or target replacement while the desktop is stopped", async () => {
    for (const leaf of ["runtimePath", "entrypointPath", "targetPath"] as const) {
      const executable = await executableConfiguration();
      const file = await privateConfigurationFile(executable.value);
      const replacement =
        leaf === "entrypointPath"
          ? Buffer.from("#!/usr/bin/env node\n// replaced\n")
          : (() => {
              const bytes = arm64MachOExecutable();
              bytes.writeUInt32LE(1, 24);
              return bytes;
            })();
      await writeFile(executable[leaf], replacement, {
        mode: leaf === "entrypointPath" ? 0o600 : 0o700,
      });

      await expect(
        loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    }
  });

  it("rejects origin drift, extra credentials, ambiguous targets, and invalid adapter IDs", async () => {
    const executable = await executableConfiguration();
    const invalidValues = [
      { ...executable.value, token: "agent-secret" },
      { ...executable.value, targets: [executable.value.target, executable.value.target] },
      {
        ...executable.value,
        target: { ...(executable.value.target as object), adapterId: "invalid adapter" },
      },
      {
        ...executable.value,
        target: {
          ...(executable.value.target as object),
          arguments: ["/untrusted/adapter-script.js"],
        },
      },
    ];
    for (const value of invalidValues) {
      const file = await privateConfigurationFile(value);
      await expect(
        loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    }
    const file = await privateConfigurationFile(executable.value);
    await expect(
      loadConfiguration({
        filePath: file,
        expectedApiOrigin: "https://another.example.test",
      }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it("requires a private regular bounded file and rejects symlinks", async () => {
    const executable = await executableConfiguration();
    const file = await privateConfigurationFile(executable.value);
    await chmod(file, 0o644);
    await expect(
      loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });

    await writeFile(file, "x".repeat(AGENT_WAKE_CONFIGURATION_MAX_BYTES + 1));
    await chmod(file, 0o600);
    await expect(
      loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });

    const target = await privateConfigurationFile(executable.value);
    const link = path.join(path.dirname(target), "wake-link.json");
    await symlink(target, link);
    await expect(
      loadConfiguration({ filePath: link, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it("rejects symlinked, non-regular, non-executable, and group/world-writable executables", async () => {
    const executable = await executableConfiguration();
    const enrollmentFile = await privateConfigurationFile(executable.value);

    for (const mode of [0o600, 0o720, 0o702]) {
      await chmod(executable.runtimePath, mode);
      await expect(
        loadConfiguration({ filePath: enrollmentFile, expectedApiOrigin: API_ORIGIN }),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    }
    await chmod(executable.runtimePath, 0o700);

    const linkedConfiguration = await executableConfiguration();
    const linkedTarget = path.join(path.dirname(linkedConfiguration.runtimePath), "linked-node");
    await symlink(linkedConfiguration.runtimePath, linkedTarget);
    const linkedEnrollment = await privateConfigurationFile(
      configuration({
        runtime: linkedTarget,
        entrypoint: linkedConfiguration.entrypointPath,
        target: linkedConfiguration.targetPath,
      }),
    );
    await expect(
      loadConfiguration({ filePath: linkedEnrollment, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });

    const directoryConfiguration = await executableConfiguration();
    const directoryTarget = path.join(
      path.dirname(directoryConfiguration.runtimePath),
      "not-a-file",
    );
    await mkdir(directoryTarget, { mode: 0o700 });
    const directoryEnrollment = await privateConfigurationFile(
      configuration({
        runtime: directoryTarget,
        entrypoint: directoryConfiguration.entrypointPath,
        target: directoryConfiguration.targetPath,
      }),
    );
    await expect(
      loadConfiguration({ filePath: directoryEnrollment, expectedApiOrigin: API_ORIGIN }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it("rejects script and universal target adapters in the thin macOS arm64 pilot", async () => {
    const executable = await executableConfiguration();
    const invalidTargets = [
      ["script-target", Buffer.from("#!/usr/bin/env node\n")],
      ["universal-target", universalMachOExecutable()],
    ] as const;

    for (const [name, contents] of invalidTargets) {
      const target = path.join(path.dirname(executable.targetPath), name);
      await writeFile(target, contents, { mode: 0o700 });
      const file = await privateConfigurationFile(
        configuration(
          {
            runtime: executable.runtimePath,
            entrypoint: executable.entrypointPath,
            target,
          },
          {
            runtime: sha256(arm64MachOExecutable()),
            entrypoint: sha256(CLI_ENTRYPOINT),
            target: sha256(contents),
          },
        ),
      );

      await expect(
        loadConfiguration({
          filePath: file,
          expectedApiOrigin: API_ORIGIN,
          platform: "darwin",
          architecture: "arm64",
        }),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    }
  });

  it("rejects mutable sibling and rpath-linked native dependencies", async () => {
    const executable = await executableConfiguration();
    const target = path.join(path.dirname(executable.targetPath), "sibling-linked-target");
    await writeFile(target, arm64MachOExecutable("@loader_path/libtarget.dylib"), {
      mode: 0o700,
    });
    const file = await privateConfigurationFile(
      configuration(
        {
          runtime: executable.runtimePath,
          entrypoint: executable.entrypointPath,
          target,
        },
        {
          runtime: sha256(arm64MachOExecutable()),
          entrypoint: sha256(CLI_ENTRYPOINT),
          target: sha256(arm64MachOExecutable("@loader_path/libtarget.dylib")),
        },
      ),
    );

    await expect(
      loadConfiguration({
        filePath: file,
        expectedApiOrigin: API_ORIGIN,
        platform: "darwin",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
  });

  it.each([
    ["fixed VM file", 0x09],
    ["prebound dylib", 0x10],
    ["unknown", 0x7ffffffe],
  ] as const)(
    "rejects the %s load command until its loader behavior is allowed",
    async (_name, command) => {
      const executable = await executableConfiguration();
      const contents = arm64MachOWithCommand(command);
      const target = path.join(
        path.dirname(executable.targetPath),
        `command-${command.toString(16)}`,
      );
      await writeFile(target, contents, { mode: 0o700 });
      const file = await privateConfigurationFile(
        configuration(
          {
            runtime: executable.runtimePath,
            entrypoint: executable.entrypointPath,
            target,
          },
          {
            runtime: sha256(arm64MachOExecutable()),
            entrypoint: sha256(CLI_ENTRYPOINT),
            target: sha256(contents),
          },
        ),
      );

      await expect(
        loadConfiguration({
          filePath: file,
          expectedApiOrigin: API_ORIGIN,
          platform: "darwin",
          architecture: "arm64",
        }),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    },
  );

  it("allows the pinned Node runtime to open a non-executable CLI entrypoint", async () => {
    const executable = await executableConfiguration();
    await chmod(executable.entrypointPath, 0o600);
    const file = await privateConfigurationFile(executable.value);

    await expect(
      loadConfiguration({ filePath: file, expectedApiOrigin: API_ORIGIN }),
    ).resolves.toMatchObject({
      source: { cliEntrypointPin: { fileKind: "cli-entrypoint", mode: 0o100600 } },
    });
  });

  it("allows only the enrolled account or root to own an executable", async () => {
    if (process.platform === "win32" || process.getuid === undefined || process.getuid() === 0) {
      return;
    }
    const executable = await executableConfiguration();

    await expect(
      pinExecutable(executable.runtimePath, { currentUid: process.getuid() + 1 }),
    ).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
      message: "Agent wake executable integrity verification failed",
    });
  });

  it("rejects writable or symlinked executable ancestors", async () => {
    const directory = await temporaryDirectory(path.join(process.cwd(), ".hype-wake-ancestor-"));
    const writableParent = path.join(directory, "writable");
    await mkdir(writableParent, { mode: 0o770 });
    await chmod(writableParent, 0o770);
    const writableExecutable = path.join(writableParent, "runtime");
    await writeFile(writableExecutable, arm64MachOExecutable(), { mode: 0o700 });
    // Uses the real, unmasked production default (no `statAncestor` override) so this test proves
    // the actual policy, not a masked stand-in.
    await expect(pinAgentWakeExecutable(writableExecutable)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });

    const realParent = path.join(directory, "real");
    const linkedParent = path.join(directory, "linked");
    await mkdir(realParent, { mode: 0o700 });
    const linkedExecutable = path.join(realParent, "runtime");
    await writeFile(linkedExecutable, arm64MachOExecutable(), { mode: 0o700 });
    await symlink(realParent, linkedParent);
    await expect(pinAgentWakeExecutable(path.join(linkedParent, "runtime"))).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });
  });

  it("still rejects a group-writable ancestor whose real permissions are left unmasked by the injected seam", async () => {
    const directory = await temporaryDirectory(
      path.join(process.cwd(), ".hype-wake-ancestor-seam-"),
    );
    const writableParent = path.join(directory, "writable");
    await mkdir(writableParent, { mode: 0o775 });
    await chmod(writableParent, 0o775);
    const executablePath = path.join(writableParent, "runtime");
    await writeFile(executablePath, arm64MachOExecutable(), { mode: 0o700 });

    // `trustedAncestorsExcept` trusts every ancestor above `writableParent`, masking this
    // checkout's own ambient ancestor permissions (already group-writable on this host), and
    // passes `writableParent` itself through to the real, unmasked production policy. That
    // isolates the rejection to exactly the fixture's own deliberately group-writable directory,
    // not to an ambient checkout ancestor. The seam exists only for tests to opt into; it must
    // never be wired into `pinAgentWakeExecutable`, `pinAgentWakeCliEntrypoint`,
    // `verifyAgentWakeExecutablePin`, or `loadAgentWakeConfiguration` by default.
    await expect(
      pinAgentWakeExecutable(executablePath, {
        statAncestor: trustedAncestorsExcept(writableParent),
      }),
    ).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });
  });

  it("rechecks pinned ancestor permissions before use", async () => {
    const executable = await executableConfiguration();
    const pin = await pinExecutable(executable.runtimePath);
    const parent = path.dirname(executable.runtimePath);

    await chmod(parent, 0o770);
    await expect(verifyPin(pin)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });
  });

  it("detects path replacement, symlink substitution, and in-place content changes after pinning", async () => {
    const replaced = await executableConfiguration();
    const replacedPin = await pinExecutable(replaced.runtimePath);
    const replacementPath = path.join(path.dirname(replaced.runtimePath), "replacement-node");
    await writeFile(replacementPath, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    await rename(replacementPath, replaced.runtimePath);
    await expect(verifyPin(replacedPin)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });

    const linked = await executableConfiguration();
    const linkedPin = await pinExecutable(linked.runtimePath);
    const originalPath = path.join(path.dirname(linked.runtimePath), "original-node");
    await rename(linked.runtimePath, originalPath);
    await symlink(originalPath, linked.runtimePath);
    await expect(verifyPin(linkedPin)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });

    const modified = await executableConfiguration();
    const modifiedPin = await pinExecutable(modified.runtimePath);
    await writeFile(modified.runtimePath, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
    await expect(verifyPin(modifiedPin)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });
  });

  it("detects replacement of the self-contained CLI entrypoint after pinning", async () => {
    const executable = await executableConfiguration();
    const enrollment = await privateConfigurationFile(executable.value);
    const loaded = await loadConfiguration({
      filePath: enrollment,
      expectedApiOrigin: API_ORIGIN,
    });
    const pin = loaded.source.cliEntrypointPin;
    expect(pin).toBeDefined();
    const replacementPath = path.join(
      path.dirname(executable.entrypointPath),
      "replacement-cli.js",
    );
    await writeFile(replacementPath, "throw new Error('replacement');\n", { mode: 0o600 });
    await rename(replacementPath, executable.entrypointPath);

    await expect(verifyPin(pin!)).rejects.toMatchObject({
      name: "AgentWakeExecutableIntegrityError",
    });
  });
});
