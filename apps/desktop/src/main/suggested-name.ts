import { displayNameSchema } from "@hmm-chat/contracts";

export class SuggestedNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestedNameError";
  }
}

function readNameArgument(argv: readonly string[]): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--name") {
      const next = argv[index + 1];
      if (value !== undefined || next === undefined || next.startsWith("--")) {
        throw new SuggestedNameError("--name requires exactly one value");
      }
      value = next;
      index += 1;
      continue;
    }

    if (argument?.startsWith("--name=")) {
      if (value !== undefined) {
        throw new SuggestedNameError("--name can only be provided once");
      }
      value = argument.slice("--name=".length);
    }
  }

  return value;
}

/**
 * Resolves the name pre-filled on the sign-in form.
 *
 * This is a convenience hint only. The server derives every message author from the session, so a
 * wrong or absent value here cannot affect who a message is attributed to. An empty string means
 * the form starts blank.
 */
export function resolveSuggestedName(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  const candidate = readNameArgument(argv) ?? env.HMM_CHAT_NAME;
  if (candidate === undefined || candidate.trim() === "") {
    return "";
  }

  const result = displayNameSchema.safeParse(candidate);
  if (!result.success) {
    throw new SuggestedNameError(
      "The provided name is not usable. Start with: npm run dev -- --name <display-name>",
    );
  }

  return result.data;
}
