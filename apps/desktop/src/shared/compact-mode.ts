import { compactModePreferenceSchema, type CompactModePreference } from "@hmm-chat/contracts";

const INITIAL_COMPACT_MODE_ARGUMENT_PREFIX = "--hmm-chat-initial-compact-mode=";

/**
 * Supplies the already-initialized compact-mode preference to a sandboxed renderer before
 * asynchronous IPC is available. The preference is non-secret, and the preload validates the
 * encoded value again.
 */
export function createInitialCompactModeArgument(enabled: CompactModePreference): string {
  const canonicalEnabled = compactModePreferenceSchema.parse(enabled);
  return `${INITIAL_COMPACT_MODE_ARGUMENT_PREFIX}${canonicalEnabled}`;
}

/**
 * Strictly parses the compact-mode startup argument: only the literal `true` or `false` values
 * are accepted, the last matching argument wins, and anything else resolves to `null`.
 */
export function parseInitialCompactModeArgument(
  argv: readonly string[],
): CompactModePreference | null {
  let argument: string | undefined;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const candidate = argv[index];
    if (candidate?.startsWith(INITIAL_COMPACT_MODE_ARGUMENT_PREFIX) === true) {
      argument = candidate;
      break;
    }
  }
  if (argument === undefined) {
    return null;
  }

  const source = argument.slice(INITIAL_COMPACT_MODE_ARGUMENT_PREFIX.length);
  if (source === "true") {
    return true;
  }
  if (source === "false") {
    return false;
  }
  return null;
}

/**
 * Keeps cosmetic startup data from disabling the entire preload bridge. Main sends authoritative
 * state again after load, so this fallback is used only until compact-mode IPC hydrates the
 * renderer.
 */
export function resolveInitialCompactModeArgument(argv: readonly string[]): CompactModePreference {
  const parsed = parseInitialCompactModeArgument(argv);
  return parsed ?? false;
}
