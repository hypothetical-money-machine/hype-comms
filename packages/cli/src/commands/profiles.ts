import { booleanOption, parseCommandArguments, requirePositionals, stringOption } from "../argv.js";
import {
  configDirectory,
  loadProfileStore,
  normalizeApiOrigin,
  saveProfile,
  updateProfileStore,
  validateProfileName,
} from "../config.js";
import { UsageError } from "../errors.js";
import { writeResult } from "../output.js";
import type { CommandContext } from "../types.js";

function publicProfile(
  name: string,
  profile: { apiOrigin: string; credential?: { kind: string } | undefined },
) {
  return {
    name,
    apiOrigin: profile.apiOrigin,
    credential: profile.credential?.kind ?? null,
  };
}

export async function profilesCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const directory = configDirectory(context.runtime);
  if (subcommand === "list") {
    requirePositionals(parseCommandArguments(args, {}), 0);
    const store = await loadProfileStore(directory);
    writeResult(
      context.runtime.io,
      {
        defaultProfile: store.defaultProfile,
        profiles: Object.entries(store.profiles)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, profile]) => publicProfile(name, profile)),
      },
      context.options.json,
    );
    return;
  }

  if (subcommand === "show") {
    const parsed = parseCommandArguments(args, {});
    const [requested] = requirePositionals(parsed, 0, 1);
    const store = await loadProfileStore(directory);
    const name = validateProfileName(
      requested ??
        context.options.profile ??
        context.runtime.env.HMM_CHAT_PROFILE ??
        store.defaultProfile,
    );
    const profile = store.profiles[name];
    if (profile === undefined)
      throw new UsageError(`Profile ${name} does not exist`, "PROFILE_NOT_FOUND");
    writeResult(
      context.runtime.io,
      { ...publicProfile(name, profile), isDefault: name === store.defaultProfile },
      context.options.json,
    );
    return;
  }

  if (subcommand === "set") {
    const parsed = parseCommandArguments(args, {
      "api-origin": { kind: "string" },
      default: { kind: "boolean" },
    });
    const [nameValue] = requirePositionals(parsed, 1);
    const origin = stringOption(parsed, "api-origin") ?? context.options.apiOrigin;
    if (origin === undefined) {
      throw new UsageError("profiles set requires --api-origin", "MISSING_API_ORIGIN");
    }
    const name = validateProfileName(nameValue!);
    const saved = await saveProfile(
      context.runtime,
      name,
      { apiOrigin: normalizeApiOrigin(origin) },
      booleanOption(parsed, "default"),
    );
    writeResult(context.runtime.io, publicProfile(name, saved), context.options.json);
    return;
  }

  if (subcommand === "use") {
    const parsed = parseCommandArguments(args, {});
    const [nameValue] = requirePositionals(parsed, 1);
    const name = validateProfileName(nameValue!);
    await updateProfileStore(context.runtime, (store) => {
      if (store.profiles[name] === undefined) {
        throw new UsageError(`Profile ${name} does not exist`, "PROFILE_NOT_FOUND");
      }
      store.defaultProfile = name;
    });
    writeResult(context.runtime.io, { defaultProfile: name }, context.options.json);
    return;
  }

  if (subcommand === "remove") {
    const parsed = parseCommandArguments(args, {});
    const [nameValue] = requirePositionals(parsed, 1);
    const name = validateProfileName(nameValue!);
    await updateProfileStore(context.runtime, (store) => {
      if (store.profiles[name] === undefined) {
        throw new UsageError(`Profile ${name} does not exist`, "PROFILE_NOT_FOUND");
      }
      delete store.profiles[name];
      if (store.defaultProfile === name) store.defaultProfile = "default";
    });
    writeResult(context.runtime.io, { removed: name }, context.options.json);
    return;
  }

  throw new UsageError("Usage: hmm-chat-cli profiles <list|show|set|use|remove>");
}
