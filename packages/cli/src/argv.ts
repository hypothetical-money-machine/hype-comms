import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";
import type { GlobalOptions } from "./types.js";

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
}

interface OptionDefinition {
  readonly kind: "boolean" | "string";
  readonly multiple?: boolean;
}

export type OptionDefinitions = Readonly<Record<string, OptionDefinition>>;

function tokenize(args: readonly string[], definitions: OptionDefinitions) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: false,
      tokens: true,
      options: Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [
          name,
          {
            type: definition.kind,
            ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
          },
        ]),
      ),
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid command arguments");
  }
}

function validateOptionValue(
  name: string,
  definition: OptionDefinition,
  value: string | undefined,
  inlineValue: boolean | undefined,
): void {
  if (definition.kind === "boolean") {
    if (value !== undefined) throw new UsageError(`Option --${name} does not accept a value`);
  } else if (value === undefined || (inlineValue !== true && value.startsWith("--"))) {
    throw new UsageError(`Option --${name} requires a value`);
  }
}

export function parseCommandArguments(
  args: readonly string[],
  definitions: OptionDefinitions,
): ParsedArguments {
  const parsed = tokenize(args, definitions);
  const options: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  const singleDashArguments = new Set<number>();
  for (const token of parsed.tokens) {
    if (token.kind === "positional") {
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== "option") continue;
    // The CLI has only long options; keep the established single-dash positional syntax.
    if (!token.rawName.startsWith("--")) {
      if (!singleDashArguments.has(token.index)) positionals.push(args[token.index]!);
      singleDashArguments.add(token.index);
      continue;
    }
    const definition = definitions[token.name];
    if (definition === undefined) throw new UsageError(`Unknown option --${token.name}`);
    validateOptionValue(token.name, definition, token.value, token.inlineValue);
    if (definition.kind === "boolean") {
      options[token.name] = true;
      continue;
    }
    const value = token.value!;
    if (definition.multiple === true) {
      const existing = options[token.name];
      options[token.name] = [...(Array.isArray(existing) ? existing : []), value];
    } else {
      if (options[token.name] !== undefined)
        throw new UsageError(`Option --${token.name} may only be used once`);
      options[token.name] = value;
    }
  }
  return { positionals, options };
}

export function stringOption(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(parsed: ParsedArguments, name: string): boolean {
  return parsed.options[name] === true;
}

export function multipleOption(parsed: ParsedArguments, name: string): readonly string[] {
  const value = parsed.options[name];
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value: string, name: string, maximum?: number): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new UsageError(`--${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (maximum !== undefined && number > maximum)) {
    throw new UsageError(`--${name} is outside the supported range`);
  }
  return number;
}

export function integerOption(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
  maximum?: number,
): number {
  const value = stringOption(parsed, name);
  return value === undefined ? fallback : positiveInteger(value, name, maximum);
}

export function extractGlobalOptions(argv: readonly string[]): {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
} {
  const definitions: OptionDefinitions = {
    json: { kind: "boolean" },
    "adapter-protocol": { kind: "string" },
    profile: { kind: "string" },
    "api-origin": { kind: "string" },
    "timeout-ms": { kind: "string" },
  };
  const parsed = tokenize(argv, definitions);
  const removed = new Set<number>();
  const values = new Map<string, string | true>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || !token.rawName.startsWith("--")) continue;
    const definition = definitions[token.name];
    if (definition === undefined) continue;
    validateOptionValue(token.name, definition, token.value, token.inlineValue);
    if (values.has(token.name) && token.name !== "json" && token.name !== "timeout-ms")
      throw new UsageError(`--${token.name} may only be used once`);
    values.set(token.name, token.value ?? true);
    removed.add(token.index);
    if (definition.kind === "string" && token.inlineValue !== true) removed.add(token.index + 1);
  }
  const adapterProtocol = values.get("adapter-protocol");
  if (adapterProtocol !== undefined && adapterProtocol !== "1")
    throw new UsageError("This CLI supports adapter protocol 1", "ADAPTER_UPGRADE_REQUIRED");
  const profile = values.get("profile");
  const apiOrigin = values.get("api-origin");
  const timeout = values.get("timeout-ms");
  return {
    args: argv.filter((_, index) => !removed.has(index)),
    options: {
      json: values.has("json") || adapterProtocol !== undefined,
      ...(adapterProtocol === undefined ? {} : { adapterProtocol: 1 as const }),
      ...(typeof profile === "string" ? { profile } : {}),
      ...(typeof apiOrigin === "string" ? { apiOrigin } : {}),
      timeoutMs:
        typeof timeout === "string" ? positiveInteger(timeout, "timeout-ms", 300_000) : 30_000,
    },
  };
}

export function requirePositionals(
  parsed: ParsedArguments,
  minimum: number,
  maximum = minimum,
): readonly string[] {
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    throw new UsageError("The command received the wrong number of arguments");
  }
  return parsed.positionals;
}
