import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  open,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  agentTokenSecretSchema,
  requestAgentEnrollmentSchema,
  sessionTokenSchema,
} from "@hype-comms/contracts";
import { z } from "zod";

import { UsageError } from "./errors.js";
import type { GlobalOptions, Runtime } from "./types.js";

const profileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const agentTokenSchema = agentTokenSecretSchema;

const storedCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), sessionToken: sessionTokenSchema }).strict(),
  z.object({ kind: z.literal("agent"), token: agentTokenSchema }).strict(),
]);

const storedProfileSchema = z
  .object({
    apiOrigin: z.string().min(1),
    credential: storedCredentialSchema.optional(),
    enrollmentOffer: z.object({ request: requestAgentEnrollmentSchema }).strict().optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.enrollmentOffer === undefined) return;
    if (profile.credential?.kind !== "agent") {
      context.addIssue({
        code: "custom",
        path: ["enrollmentOffer"],
        message: "An enrollment offer requires its candidate credential",
      });
      return;
    }
    const verifier = createHash("sha256")
      .update(profile.credential.token, "utf8")
      .digest("base64url");
    if (verifier !== profile.enrollmentOffer.request.credentialVerifier) {
      context.addIssue({
        code: "custom",
        path: ["enrollmentOffer", "request", "credentialVerifier"],
        message: "The enrollment offer does not match its candidate credential",
      });
    }
  });

const profileStoreSchema = z
  .object({
    version: z.literal(1),
    defaultProfile: profileNameSchema.default("default"),
    profiles: z.record(profileNameSchema, storedProfileSchema),
  })
  .strict();

export type StoredCredential = z.infer<typeof storedCredentialSchema>;
export type StoredProfile = z.infer<typeof storedProfileSchema>;
export type ProfileStore = z.infer<typeof profileStoreSchema>;

export interface ResolvedProfile {
  readonly name: string;
  readonly apiOrigin: string;
  readonly credential?: StoredCredential;
  readonly credentialOrigin?: string;
  readonly credentialFromEnvironment: boolean;
  readonly configDirectory: string;
}

export interface ResolvedProfileSnapshot {
  readonly profile: ResolvedProfile;
  readonly storedProfile?: StoredProfile;
}

const EMPTY_STORE: ProfileStore = {
  version: 1,
  defaultProfile: "default",
  profiles: {},
};

export function validateProfileName(name: string): string {
  const parsed = profileNameSchema.safeParse(name);
  if (!parsed.success) throw new UsageError("Invalid profile name", "INVALID_PROFILE");
  return parsed.data;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) && octets[0] === 127;
}

export function normalizeApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("The API origin is not a valid URL", "INVALID_API_ORIGIN");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UsageError("The API origin must not contain credentials", "INVALID_API_ORIGIN");
  }
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new UsageError(
      "The API origin must not contain a path, query, or fragment",
      "INVALID_API_ORIGIN",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new UsageError(
      "The API origin must use HTTPS, except for loopback development servers",
      "INSECURE_API_ORIGIN",
    );
  }
  return url.origin;
}

export function configDirectory(runtime: Pick<Runtime, "env" | "homeDirectory">): string {
  const configured = runtime.env.HYPE_COMMS_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new UsageError("HYPE_COMMS_CONFIG_DIR must be an absolute path", "INVALID_CONFIG_DIR");
    }
    return configured;
  }
  const xdg = runtime.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") {
    if (!isAbsolute(xdg)) {
      throw new UsageError("XDG_CONFIG_HOME must be an absolute path", "INVALID_CONFIG_DIR");
    }
    return join(xdg, "hype-comms");
  }
  return join(runtime.homeDirectory, ".config", "hype-comms");
}

function storePath(directory: string): string {
  return join(directory, "profiles.json");
}

function lockPath(directory: string): string {
  return join(directory, "profiles.lock");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UsageError("The configuration location must be a private directory", "UNSAFE_CONFIG");
  }
  await chmod(directory, 0o700);
}

export async function loadProfileStore(directory: string): Promise<ProfileStore> {
  await ensurePrivateDirectory(directory);
  const path = storePath(directory);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new UsageError("The profile store has unsafe filesystem permissions", "UNSAFE_CONFIG");
    }
    const content = await readFile(path, "utf8");
    const parsed = profileStoreSchema.safeParse(JSON.parse(content) as unknown);
    if (!parsed.success) throw new UsageError("The profile store is invalid", "INVALID_CONFIG");
    for (const profile of Object.values(parsed.data.profiles)) {
      normalizeApiOrigin(profile.apiOrigin);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STORE);
    if (error instanceof SyntaxError) {
      throw new UsageError("The profile store is invalid", "INVALID_CONFIG");
    }
    throw error;
  }
}

export async function saveProfileStore(directory: string, store: ProfileStore): Promise<void> {
  await ensurePrivateDirectory(directory);
  const parsed = profileStoreSchema.safeParse(store);
  if (!parsed.success) throw new UsageError("The profile store is invalid", "INVALID_CONFIG");
  for (const profile of Object.values(parsed.data.profiles)) {
    normalizeApiOrigin(profile.apiOrigin);
  }

  const path = storePath(directory);
  const temporaryPath = join(directory, `.profiles.${randomUUID()}.tmp`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const handle = await open(temporaryPath, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function acquireLock(directory: string, now: () => number): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(directory);
  const path = lockPath(directory);
  const deadline = now() + 10_000;
  while (true) {
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => {
        await unlink(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => undefined);
      const ownerText = await readFile(path, "utf8").catch(() => "");
      const ownerPid = /^\d+$/u.test(ownerText.trim()) ? Number(ownerText.trim()) : undefined;
      let ownerIsAlive = true;
      if (ownerPid !== undefined && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
        } catch (ownerError) {
          ownerIsAlive = (ownerError as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (
        (ownerPid !== undefined && !ownerIsAlive) ||
        (info !== undefined && now() - info.mtimeMs > 600_000)
      ) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (now() >= deadline) {
        throw new UsageError("Another CLI process is updating this profile", "PROFILE_LOCKED");
      }
      await delay(50);
    }
  }
}

export async function withProfileLock<T>(
  runtime: Pick<Runtime, "env" | "homeDirectory" | "now">,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = configDirectory(runtime);
  const release = await acquireLock(directory, runtime.now);
  try {
    return await operation(directory);
  } finally {
    await release();
  }
}

export async function updateProfileStore(
  runtime: Pick<Runtime, "env" | "homeDirectory" | "now">,
  update: (store: ProfileStore) => void,
): Promise<ProfileStore> {
  return withProfileLock(runtime, async (directory) => {
    const store = await loadProfileStore(directory);
    update(store);
    await saveProfileStore(directory, store);
    return store;
  });
}

function resolveProfileFromStore(
  runtime: Pick<Runtime, "env" | "homeDirectory">,
  options: Pick<GlobalOptions, "profile" | "apiOrigin">,
  behavior: { readonly ignoreEnvironmentToken?: boolean },
  directory: string,
  store: ProfileStore,
): ResolvedProfile {
  const name = validateProfileName(
    options.profile ?? runtime.env.HYPE_COMMS_PROFILE ?? store.defaultProfile,
  );
  const stored = store.profiles[name];
  const originValue = options.apiOrigin ?? runtime.env.HYPE_COMMS_API_ORIGIN ?? stored?.apiOrigin;
  if (originValue === undefined || originValue === "") {
    throw new UsageError(
      "No API origin is configured; set HYPE_COMMS_API_ORIGIN or save a profile",
      "MISSING_API_ORIGIN",
    );
  }

  const environmentToken =
    behavior.ignoreEnvironmentToken === true ? undefined : runtime.env.HYPE_COMMS_TOKEN;
  let credential: StoredCredential | undefined = stored?.credential;
  let credentialOrigin =
    stored?.credential === undefined ? undefined : normalizeApiOrigin(stored.apiOrigin);
  if (environmentToken !== undefined && environmentToken !== "") {
    const token = agentTokenSchema.safeParse(environmentToken);
    if (!token.success)
      throw new UsageError("HYPE_COMMS_TOKEN is not a valid agent token", "INVALID_TOKEN");
    credential = { kind: "agent", token: token.data };
    credentialOrigin = normalizeApiOrigin(originValue);
  }
  return {
    name,
    apiOrigin: normalizeApiOrigin(originValue),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialOrigin === undefined ? {} : { credentialOrigin }),
    credentialFromEnvironment: environmentToken !== undefined && environmentToken !== "",
    configDirectory: directory,
  };
}

export async function resolveProfileSnapshot(
  runtime: Pick<Runtime, "env" | "homeDirectory">,
  options: Pick<GlobalOptions, "profile" | "apiOrigin">,
  behavior: { readonly ignoreEnvironmentToken?: boolean } = {},
): Promise<ResolvedProfileSnapshot> {
  const directory = configDirectory(runtime);
  // Atomic profile-store replacement means this single read binds the effective origin,
  // credential, and any pending enrollment offer to one coherent filesystem snapshot.
  const store = await loadProfileStore(directory);
  const profile = resolveProfileFromStore(runtime, options, behavior, directory, store);
  const storedProfile = store.profiles[profile.name];
  return {
    profile,
    ...(storedProfile === undefined ? {} : { storedProfile }),
  };
}

export async function resolveProfile(
  runtime: Pick<Runtime, "env" | "homeDirectory">,
  options: Pick<GlobalOptions, "profile" | "apiOrigin">,
  behavior: { readonly ignoreEnvironmentToken?: boolean } = {},
): Promise<ResolvedProfile> {
  return (await resolveProfileSnapshot(runtime, options, behavior)).profile;
}

export async function saveProfile(
  runtime: Pick<Runtime, "env" | "homeDirectory" | "now">,
  name: string,
  profile: StoredProfile,
  makeDefault = false,
): Promise<StoredProfile> {
  const canonicalName = validateProfileName(name);
  const canonicalProfile: StoredProfile = {
    ...profile,
    apiOrigin: normalizeApiOrigin(profile.apiOrigin),
  };
  let saved = canonicalProfile;
  await updateProfileStore(runtime, (store) => {
    const existing = store.profiles[canonicalName];
    // A caller that supplies no credential is editing the profile, not signing out of it, so
    // carry the stored one over. The origin must match: `credentialOrigin` is derived from the
    // profile's `apiOrigin`, so keeping a credential across an origin change would silently
    // send it somewhere it was never issued for.
    saved =
      canonicalProfile.credential === undefined &&
      existing?.credential !== undefined &&
      normalizeApiOrigin(existing.apiOrigin) === canonicalProfile.apiOrigin
        ? {
            ...canonicalProfile,
            credential: existing.credential,
            ...(existing.enrollmentOffer === undefined
              ? {}
              : { enrollmentOffer: existing.enrollmentOffer }),
          }
        : canonicalProfile;
    store.profiles[canonicalName] = saved;
    if (makeDefault) store.defaultProfile = canonicalName;
  });
  return saved;
}
