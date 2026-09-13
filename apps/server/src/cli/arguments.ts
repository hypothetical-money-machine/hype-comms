import { parseArgs, type ParseArgsConfig } from "node:util";

/** Node owns tokenization; commands retain their positional, duplicate and permission policies. */
export function parseAdminArguments<Options extends NonNullable<ParseArgsConfig["options"]>>(
  args: readonly string[],
  options: Options,
  usage: string,
  allowPositionals = false,
) {
  try {
    const parsed = parseArgs({
      args: [...args],
      options,
      tokens: true,
      strict: true,
      allowPositionals,
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (options[token.name]?.multiple !== true && seen.has(token.name))
        throw new Error(`--${token.name} may only be specified once`);
      seen.add(token.name);
    }
    return parsed;
  } catch (error) {
    let message = error instanceof Error ? error.message : "Invalid arguments";
    message = message.replace(/Unknown option '([^']+)'/u, "Unknown argument: $1");
    throw new Error(`${message}\n${usage}`, { cause: error });
  }
}
