import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { entityIdSchema } from "@hype-comms/contracts";
import { z } from "zod";

import {
  agentWakeApiOriginSchema,
  agentWakeSha256Schema,
  isAgentWakeSha256Digest,
} from "./agent-wake-validation";
import { readPrivateBoundedUtf8File } from "./preference-file";

export const AGENT_WAKE_CONFIGURATION_ENV = "HYPE_COMMS_AGENT_WAKE_CONFIGURATION";
export const AGENT_WAKE_CONFIGURATION_MAX_BYTES = 64 * 1_024;

const handleSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const profileSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const executablePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0") && path.isAbsolute(value), {
    message: "Expected an absolute executable path",
  })
  .refine((value) => path.resolve(value) === value, {
    message: "Expected a lexically canonical executable path",
  })
  .refine((value) => path.resolve(value) !== path.parse(path.resolve(value)).root, {
    message: "Executable path cannot be a filesystem root",
  });
const agentWakeConfigurationSchema = z
  .object({
    version: z.literal(1),
    enrollmentId: handleSchema,
    expectedAgentUserId: entityIdSchema,
    source: z
      .object({
        credentialHandle: handleSchema,
        runtimeExecutablePath: executablePathSchema,
        runtimeExecutableSha256: agentWakeSha256Schema,
        cliEntrypointPath: executablePathSchema,
        cliEntrypointSha256: agentWakeSha256Schema,
        profile: profileSchema,
        apiOrigin: agentWakeApiOriginSchema,
      })
      .strict(),
    target: z
      .object({
        targetHandle: handleSchema,
        adapterId: handleSchema,
        executablePath: executablePathSchema,
        executableSha256: agentWakeSha256Schema,
        arguments: z.array(z.never()).length(0).default([]),
      })
      .strict(),
  })
  .strict();

type ParsedAgentWakeConfiguration = z.infer<typeof agentWakeConfigurationSchema>;

/**
 * Immutable executable identity established while the private enrollment file is loaded. Paths
 * remain internal to the main process and are never included in public errors or diagnostics.
 */
export interface AgentWakeExecutablePin {
  readonly version: 1;
  readonly fileKind: AgentWakePinnedFileKind;
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly accountUid: number;
  readonly device: string;
  readonly inode: string;
  readonly ownerUid: number;
  readonly groupId: number;
  readonly mode: number;
  readonly size: string;
  readonly modificationTimeNs: string;
  readonly changeTimeNs: string;
  readonly sha256: string;
  readonly ancestors: readonly AgentWakeExecutableAncestorPin[];
}

export type AgentWakePinnedFileKind = "cli-entrypoint" | "native-executable";

export interface AgentWakeExecutableAncestorPin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly ownerUid: number;
  readonly groupId: number;
  readonly mode: number;
}

export type AgentWakeConfiguration = ParsedAgentWakeConfiguration & {
  source: ParsedAgentWakeConfiguration["source"] & {
    /** Derived from the native runtime itself; never accepted from enrollment JSON. */
    runtimeExecutablePin?: AgentWakeExecutablePin;
    /** Derived from the self-contained CLI bundle; never accepted from enrollment JSON. */
    cliEntrypointPin?: AgentWakeExecutablePin;
  };
  target: ParsedAgentWakeConfiguration["target"] & {
    /** Derived from the executable itself; never accepted from enrollment JSON. */
    executablePin?: AgentWakeExecutablePin;
  };
};

const EXECUTABLE_HASH_BUFFER_BYTES = 64 * 1_024;
const MACHO_HEADER_64_BYTES = 32;
const MAX_MACHO_LOAD_COMMAND_BYTES = 4 * 1_024 * 1_024;
const MAX_MACHO_LOAD_COMMANDS = 4_096;

const MACHO_LOAD_DYLIB_COMMANDS = new Set([
  0x0c, // LC_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);

// These commands carry only mapped segments, entry points, link-edit metadata, version/signing
// metadata, or in-image routines. Dependency and dyld paths are validated separately above. A new
// or obsolete command is rejected until its complete loader behavior is reviewed.
const MACHO_SAFE_NON_PATH_COMMANDS = new Set([
  0x02, // LC_SYMTAB
  0x04, // LC_THREAD
  0x05, // LC_UNIXTHREAD
  0x0b, // LC_DYSYMTAB
  0x11, // LC_ROUTINES
  0x19, // LC_SEGMENT_64
  0x1a, // LC_ROUTINES_64
  0x1b, // LC_UUID
  0x1d, // LC_CODE_SIGNATURE
  0x1e, // LC_SEGMENT_SPLIT_INFO
  0x21, // LC_ENCRYPTION_INFO
  0x22, // LC_DYLD_INFO
  0x80000022, // LC_DYLD_INFO_ONLY
  0x24, // LC_VERSION_MIN_MACOSX
  0x26, // LC_FUNCTION_STARTS
  0x80000028, // LC_MAIN
  0x29, // LC_DATA_IN_CODE
  0x2a, // LC_SOURCE_VERSION
  0x2b, // LC_DYLIB_CODE_SIGN_DRS
  0x2c, // LC_ENCRYPTION_INFO_64
  0x2e, // LC_LINKER_OPTIMIZATION_HINT
  0x31, // LC_NOTE
  0x32, // LC_BUILD_VERSION
  0x80000033, // LC_DYLD_EXPORTS_TRIE
  0x80000034, // LC_DYLD_CHAINED_FIXUPS
  0x36, // LC_ATOM_INFO
  0x37, // LC_FUNCTION_VARIANTS
  0x38, // LC_FUNCTION_VARIANT_FIXUPS
  0x39, // LC_TARGET_TRIPLE
]);

/** Stable, non-sensitive failure independent of the executable pathname or contents. */
export class AgentWakeExecutableIntegrityError extends Error {
  constructor() {
    super("Agent wake executable integrity verification failed");
    this.name = "AgentWakeExecutableIntegrityError";
  }
}

function executableIntegrityError(): AgentWakeExecutableIntegrityError {
  return new AgentWakeExecutableIntegrityError();
}

function safeNumber(value: bigint): number | null {
  const converted = Number(value);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}

function sameOpenedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateExecutableMetadata(
  metadata: BigIntStats,
  accountUid: number,
  requireExecutable: boolean,
): void {
  const ownerUid = safeNumber(metadata.uid);
  const mode = safeNumber(metadata.mode);
  if (
    !metadata.isFile() ||
    ownerUid === null ||
    mode === null ||
    (ownerUid !== accountUid && ownerUid !== 0) ||
    (mode & 0o022) !== 0 ||
    (requireExecutable && (mode & 0o111) === 0)
  ) {
    throw executableIntegrityError();
  }
}

function ancestorPaths(filePath: string): readonly string[] {
  const parsed = path.parse(filePath);
  const relativeParts = path.relative(parsed.root, path.dirname(filePath)).split(path.sep);
  const ancestors = [parsed.root];
  let current = parsed.root;
  for (const part of relativeParts) {
    if (part === "") continue;
    current = path.join(current, part);
    ancestors.push(current);
  }
  return ancestors;
}

function trustedAncestorPin(
  ancestorPath: string,
  metadata: BigIntStats,
  accountUid: number,
): AgentWakeExecutableAncestorPin {
  const ownerUid = safeNumber(metadata.uid);
  const groupId = safeNumber(metadata.gid);
  const mode = safeNumber(metadata.mode);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    ownerUid === null ||
    groupId === null ||
    mode === null ||
    (ownerUid !== accountUid && ownerUid !== 0) ||
    (mode & 0o022) !== 0
  ) {
    throw executableIntegrityError();
  }
  return {
    path: ancestorPath,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    ownerUid,
    groupId,
    mode,
  };
}

async function inspectTrustedAncestors(
  filePath: string,
  accountUid: number,
): Promise<readonly AgentWakeExecutableAncestorPin[]> {
  return Promise.all(
    ancestorPaths(filePath).map(async (ancestorPath) =>
      trustedAncestorPin(ancestorPath, await lstat(ancestorPath, { bigint: true }), accountUid),
    ),
  );
}

function sameAncestorPins(
  left: readonly AgentWakeExecutableAncestorPin[],
  right: readonly AgentWakeExecutableAncestorPin[],
): boolean {
  return (
    left.length === right.length &&
    left.every((ancestor, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        ancestor.path === candidate.path &&
        ancestor.device === candidate.device &&
        ancestor.inode === candidate.inode &&
        ancestor.ownerUid === candidate.ownerUid &&
        ancestor.groupId === candidate.groupId &&
        ancestor.mode === candidate.mode
      );
    })
  );
}

async function hashOpenedExecutable(file: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(EXECUTABLE_HASH_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return digest.digest("hex");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < result.byteLength) {
    const { bytesRead } = await file.read(
      result,
      offset,
      result.byteLength - offset,
      position + offset,
    );
    if (bytesRead === 0) throw executableIntegrityError();
    offset += bytesRead;
  }
  return result;
}

function machoCommandString(command: Buffer, minimumOffset: number): string {
  const stringOffset = command.readUInt32LE(8);
  if (stringOffset < minimumOffset || stringOffset >= command.byteLength) {
    throw executableIntegrityError();
  }
  const end = command.indexOf(0, stringOffset);
  if (end < 0) throw executableIntegrityError();
  const bytes = command.subarray(stringOffset, end);
  if (bytes.byteLength === 0 || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw executableIntegrityError();
  }
  return bytes.toString("ascii");
}

function validateMachOLoadCommands(commands: Buffer, commandCount: number): void {
  let offset = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commands.byteLength) throw executableIntegrityError();
    const commandType = commands.readUInt32LE(offset);
    const commandSize = commands.readUInt32LE(offset + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || offset + commandSize > commands.byteLength) {
      throw executableIntegrityError();
    }
    const command = commands.subarray(offset, offset + commandSize);
    if (MACHO_LOAD_DYLIB_COMMANDS.has(commandType)) {
      if (commandSize < 24) throw executableIntegrityError();
      const dependency = machoCommandString(command, 24);
      if (
        path.posix.normalize(dependency) !== dependency ||
        (!dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/"))
      ) {
        throw executableIntegrityError();
      }
    } else if (commandType === 0x0e) {
      // LC_LOAD_DYLINKER
      if (commandSize < 12 || machoCommandString(command, 12) !== "/usr/lib/dyld") {
        throw executableIntegrityError();
      }
    } else if (!MACHO_SAFE_NON_PATH_COMMANDS.has(commandType)) {
      throw executableIntegrityError();
    }
    offset += commandSize;
  }
  if (offset !== commands.byteLength) throw executableIntegrityError();
}

async function validateNativeExecutable(
  file: FileHandle,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): Promise<void> {
  if (platform !== "darwin") return;
  if (architecture !== "arm64") throw executableIntegrityError();
  const header = await readExact(file, MACHO_HEADER_64_BYTES, 0);
  if (
    header.readUInt32LE(0) !== 0xfeedfacf ||
    header.readUInt32LE(4) !== 0x0100000c ||
    header.readUInt32LE(12) !== 2
  ) {
    throw executableIntegrityError();
  }
  const commandCount = header.readUInt32LE(16);
  const commandBytes = header.readUInt32LE(20);
  if (
    commandCount === 0 ||
    commandCount > MAX_MACHO_LOAD_COMMANDS ||
    commandBytes < commandCount * 8 ||
    commandBytes > MAX_MACHO_LOAD_COMMAND_BYTES
  ) {
    throw executableIntegrityError();
  }
  validateMachOLoadCommands(
    await readExact(file, commandBytes, MACHO_HEADER_64_BYTES),
    commandCount,
  );
}

interface InspectExecutableOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly currentUid?: number | undefined;
}

async function inspectExecutable(
  executablePath: string,
  fileKind: AgentWakePinnedFileKind,
  options: InspectExecutableOptions = {},
): Promise<AgentWakeExecutablePin> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const accountUid =
    options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (
    platform === "win32" ||
    accountUid === undefined ||
    !Number.isSafeInteger(accountUid) ||
    accountUid < 0
  ) {
    throw executableIntegrityError();
  }
  const configuredPath = path.resolve(executablePath);
  if (
    !path.isAbsolute(executablePath) ||
    configuredPath !== executablePath ||
    configuredPath === path.parse(configuredPath).root
  ) {
    throw executableIntegrityError();
  }

  let file: FileHandle | undefined;
  let result: AgentWakeExecutablePin | null = null;
  let failed = false;
  try {
    const ancestorsBefore = await inspectTrustedAncestors(configuredPath, accountUid);
    const pathMetadataBefore = await lstat(configuredPath, { bigint: true });
    if (pathMetadataBefore.isSymbolicLink() || !pathMetadataBefore.isFile()) {
      throw executableIntegrityError();
    }
    const canonicalPath = await realpath(configuredPath);
    if (canonicalPath !== configuredPath) throw executableIntegrityError();
    file = await open(
      configuredPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedMetadataBefore = await file.stat({ bigint: true });
    if (!sameOpenedFile(pathMetadataBefore, openedMetadataBefore)) {
      throw executableIntegrityError();
    }
    validateExecutableMetadata(openedMetadataBefore, accountUid, fileKind === "native-executable");
    if (fileKind === "native-executable") {
      await validateNativeExecutable(file, platform, architecture);
    }
    const sha256 = await hashOpenedExecutable(file);
    const openedMetadataAfter = await file.stat({ bigint: true });
    const pathMetadataAfter = await lstat(configuredPath, { bigint: true });
    const canonicalPathAfter = await realpath(configuredPath);
    const ancestorsAfter = await inspectTrustedAncestors(configuredPath, accountUid);
    if (
      canonicalPathAfter !== canonicalPath ||
      pathMetadataAfter.isSymbolicLink() ||
      !sameAncestorPins(ancestorsBefore, ancestorsAfter) ||
      !sameOpenedFile(openedMetadataBefore, openedMetadataAfter) ||
      !sameOpenedFile(openedMetadataAfter, pathMetadataAfter)
    ) {
      throw executableIntegrityError();
    }
    validateExecutableMetadata(openedMetadataAfter, accountUid, fileKind === "native-executable");

    const ownerUid = safeNumber(openedMetadataAfter.uid);
    const groupId = safeNumber(openedMetadataAfter.gid);
    const mode = safeNumber(openedMetadataAfter.mode);
    if (ownerUid === null || groupId === null || mode === null) {
      throw executableIntegrityError();
    }
    result = Object.freeze({
      version: 1,
      fileKind,
      configuredPath,
      canonicalPath,
      accountUid,
      device: openedMetadataAfter.dev.toString(),
      inode: openedMetadataAfter.ino.toString(),
      ownerUid,
      groupId,
      mode,
      size: openedMetadataAfter.size.toString(),
      modificationTimeNs: openedMetadataAfter.mtimeNs.toString(),
      changeTimeNs: openedMetadataAfter.ctimeNs.toString(),
      sha256,
      ancestors: ancestorsAfter,
    });
  } catch {
    failed = true;
  }
  if (file !== undefined) {
    try {
      await file.close();
    } catch {
      failed = true;
    }
  }
  if (failed || result === null) throw executableIntegrityError();
  return result;
}

export function isAgentWakeExecutablePin(
  value: unknown,
  executablePath?: string,
  expectedFileKind?: AgentWakePinnedFileKind,
): value is AgentWakeExecutablePin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgentWakeExecutablePin>;
  const configuredPath =
    executablePath === undefined || !path.isAbsolute(executablePath)
      ? undefined
      : path.resolve(executablePath);
  const expectedAncestorPaths =
    typeof candidate.configuredPath === "string" && path.isAbsolute(candidate.configuredPath)
      ? ancestorPaths(candidate.configuredPath)
      : [];
  return (
    candidate.version === 1 &&
    (candidate.fileKind === "cli-entrypoint" || candidate.fileKind === "native-executable") &&
    (expectedFileKind === undefined || candidate.fileKind === expectedFileKind) &&
    typeof candidate.configuredPath === "string" &&
    candidate.configuredPath.length <= 4_096 &&
    path.isAbsolute(candidate.configuredPath) &&
    path.resolve(candidate.configuredPath) === candidate.configuredPath &&
    !candidate.configuredPath.includes("\0") &&
    (configuredPath === undefined || candidate.configuredPath === configuredPath) &&
    typeof candidate.canonicalPath === "string" &&
    candidate.canonicalPath.length <= 4_096 &&
    path.isAbsolute(candidate.canonicalPath) &&
    candidate.canonicalPath === candidate.configuredPath &&
    !candidate.canonicalPath.includes("\0") &&
    typeof candidate.accountUid === "number" &&
    Number.isSafeInteger(candidate.accountUid) &&
    candidate.accountUid >= 0 &&
    typeof candidate.ownerUid === "number" &&
    Number.isSafeInteger(candidate.ownerUid) &&
    candidate.ownerUid >= 0 &&
    typeof candidate.groupId === "number" &&
    Number.isSafeInteger(candidate.groupId) &&
    candidate.groupId >= 0 &&
    typeof candidate.mode === "number" &&
    Number.isSafeInteger(candidate.mode) &&
    (candidate.mode & 0o170000) === 0o100000 &&
    (candidate.mode & 0o022) === 0 &&
    (candidate.fileKind === "cli-entrypoint" || (candidate.mode & 0o111) !== 0) &&
    (candidate.ownerUid === candidate.accountUid || candidate.ownerUid === 0) &&
    typeof candidate.device === "string" &&
    /^\d+$/u.test(candidate.device) &&
    typeof candidate.inode === "string" &&
    /^\d+$/u.test(candidate.inode) &&
    typeof candidate.size === "string" &&
    /^\d+$/u.test(candidate.size) &&
    typeof candidate.modificationTimeNs === "string" &&
    /^\d+$/u.test(candidate.modificationTimeNs) &&
    typeof candidate.changeTimeNs === "string" &&
    /^\d+$/u.test(candidate.changeTimeNs) &&
    typeof candidate.sha256 === "string" &&
    isAgentWakeSha256Digest(candidate.sha256) &&
    Array.isArray(candidate.ancestors) &&
    candidate.ancestors.length === expectedAncestorPaths.length &&
    candidate.ancestors.every((ancestor, index) => {
      const value = ancestor as Partial<AgentWakeExecutableAncestorPin>;
      return (
        value.path === expectedAncestorPaths[index] &&
        typeof value.device === "string" &&
        /^\d+$/u.test(value.device) &&
        typeof value.inode === "string" &&
        /^\d+$/u.test(value.inode) &&
        typeof value.ownerUid === "number" &&
        Number.isSafeInteger(value.ownerUid) &&
        (value.ownerUid === candidate.accountUid || value.ownerUid === 0) &&
        typeof value.groupId === "number" &&
        Number.isSafeInteger(value.groupId) &&
        value.groupId >= 0 &&
        typeof value.mode === "number" &&
        Number.isSafeInteger(value.mode) &&
        (value.mode & 0o170000) === 0o040000 &&
        (value.mode & 0o022) === 0
      );
    })
  );
}

/** Establishes the executable identity stored with an in-memory enrollment. */
export async function pinAgentWakeExecutable(
  executablePath: string,
  options: InspectExecutableOptions = {},
): Promise<AgentWakeExecutablePin> {
  return inspectExecutable(executablePath, "native-executable", options);
}

/** Establishes the identity of the self-contained JavaScript entrypoint executed by pinned Node. */
export async function pinAgentWakeCliEntrypoint(
  entrypointPath: string,
  options: InspectExecutableOptions = {},
): Promise<AgentWakeExecutablePin> {
  return inspectExecutable(entrypointPath, "cli-entrypoint", options);
}

/** Re-opens, re-hashes, and compares the enrolled executable immediately before a spawn. */
export async function verifyAgentWakeExecutablePin(
  pin: AgentWakeExecutablePin,
  options: InspectExecutableOptions = {},
): Promise<string> {
  if (!isAgentWakeExecutablePin(pin)) throw executableIntegrityError();
  const current = await inspectExecutable(pin.configuredPath, pin.fileKind, options);
  if (
    current.fileKind !== pin.fileKind ||
    current.canonicalPath !== pin.canonicalPath ||
    current.accountUid !== pin.accountUid ||
    current.device !== pin.device ||
    current.inode !== pin.inode ||
    current.ownerUid !== pin.ownerUid ||
    current.groupId !== pin.groupId ||
    current.mode !== pin.mode ||
    current.size !== pin.size ||
    current.modificationTimeNs !== pin.modificationTimeNs ||
    current.changeTimeNs !== pin.changeTimeNs ||
    current.sha256 !== pin.sha256 ||
    !sameAncestorPins(current.ancestors, pin.ancestors)
  ) {
    throw executableIntegrityError();
  }
  return current.canonicalPath;
}

export class AgentWakeConfigurationError extends Error {
  constructor(
    readonly code: "configuration-invalid" | "configuration-unavailable" | "not-compiled-in",
  ) {
    super(`Agent wake configuration failed: ${code}`);
    this.name = "AgentWakeConfigurationError";
  }
}

/** Resolves only a pathname; no credential or provider value is accepted through the environment. */
export function resolveAgentWakeConfigurationPath(options: {
  readonly compiledIn: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | null {
  const configured = options.env[AGENT_WAKE_CONFIGURATION_ENV]?.trim() ?? "";
  if (!options.compiledIn) {
    if (configured !== "") throw new AgentWakeConfigurationError("not-compiled-in");
    return null;
  }
  if (configured === "") return null;
  if (configured.includes("\0") || !path.isAbsolute(configured)) {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
  return resolved;
}

/** Loads a strict private file without ever copying its values into an error or log record. */
export async function loadAgentWakeConfiguration(options: {
  readonly filePath: string;
  readonly expectedApiOrigin: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly currentUid?: number | undefined;
}): Promise<AgentWakeConfiguration> {
  const source = await readPrivateBoundedUtf8File(
    options.filePath,
    AGENT_WAKE_CONFIGURATION_MAX_BYTES,
    {
      platform: options.platform,
      currentUid: options.currentUid,
    },
  );
  if (source.status === "unavailable") {
    throw new AgentWakeConfigurationError("configuration-unavailable");
  }
  if (source.status === "invalid") {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(source.value) as unknown;
  } catch {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
  const parsed = agentWakeConfigurationSchema.safeParse(value);
  if (!parsed.success || parsed.data.source.apiOrigin !== options.expectedApiOrigin) {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
  try {
    const [runtimeExecutablePin, cliEntrypointPin, targetExecutablePin] = await Promise.all([
      pinAgentWakeExecutable(parsed.data.source.runtimeExecutablePath, {
        platform: options.platform,
        architecture: options.architecture,
        currentUid: options.currentUid,
      }),
      pinAgentWakeCliEntrypoint(parsed.data.source.cliEntrypointPath, {
        platform: options.platform,
        architecture: options.architecture,
        currentUid: options.currentUid,
      }),
      pinAgentWakeExecutable(parsed.data.target.executablePath, {
        platform: options.platform,
        architecture: options.architecture,
        currentUid: options.currentUid,
      }),
    ]);
    if (
      runtimeExecutablePin.sha256 !== parsed.data.source.runtimeExecutableSha256 ||
      cliEntrypointPin.sha256 !== parsed.data.source.cliEntrypointSha256 ||
      targetExecutablePin.sha256 !== parsed.data.target.executableSha256
    ) {
      throw executableIntegrityError();
    }
    return {
      ...parsed.data,
      source: { ...parsed.data.source, runtimeExecutablePin, cliEntrypointPin },
      target: { ...parsed.data.target, executablePin: targetExecutablePin },
    };
  } catch {
    throw new AgentWakeConfigurationError("configuration-invalid");
  }
}
