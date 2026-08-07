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

function valueAfterEquals(argument: string): string | undefined {
  const index = argument.indexOf("=");
  return index === -1 ? undefined : argument.slice(index + 1);
}

function optionName(argument: string): string {
  const index = argument.indexOf("=");
  return argument.slice(2, index === -1 ? undefined : index);
}

export function parseCommandArguments(
  args: readonly string[],
  definitions: OptionDefinitions,
): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (positionalOnly || !argument.startsWith("--") || argument === "-") {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }

    const name = optionName(argument);
    const definition = definitions[name];
    if (definition === undefined) throw new UsageError(`Unknown option --${name}`);
    const inlineValue = valueAfterEquals(argument);
    if (definition.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option --${name} does not accept a value`);
      }
      options[name] = true;
      continue;
    }

    const nextValue = inlineValue ?? args[index + 1];
    if (nextValue === undefined || (inlineValue === undefined && nextValue.startsWith("--"))) {
      throw new UsageError(`Option --${name} requires a value`);
    }
    if (inlineValue === undefined) index += 1;
    if (definition.multiple === true) {
      const existing = options[name];
      options[name] = [...(Array.isArray(existing) ? existing : []), nextValue];
    } else {
      if (options[name] !== undefined)
        throw new UsageError(`Option --${name} may only be used once`);
      options[name] = nextValue;
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
  const args: string[] = [];
  let json = false;
  let profile: string | undefined;
  let apiOrigin: string | undefined;
  let timeoutMs = 30_000;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (positionalOnly) {
      args.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      args.push(argument);
      continue;
    }
    const inline = valueAfterEquals(argument);
    const takeValue = (name: string): string => {
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new UsageError(`${name} requires a value`);
      }
      if (inline === undefined) index += 1;
      return value;
    };
    if (argument === "--json") {
      json = true;
    } else if (argument === "--profile" || argument.startsWith("--profile=")) {
      if (profile !== undefined) throw new UsageError("--profile may only be used once");
      profile = takeValue("--profile");
    } else if (argument === "--api-origin" || argument.startsWith("--api-origin=")) {
      if (apiOrigin !== undefined) throw new UsageError("--api-origin may only be used once");
      apiOrigin = takeValue("--api-origin");
    } else if (argument === "--timeout-ms" || argument.startsWith("--timeout-ms=")) {
      timeoutMs = positiveInteger(takeValue("--timeout-ms"), "timeout-ms", 300_000);
    } else {
      args.push(argument);
    }
  }

  return {
    args,
    options: {
      json,
      ...(profile === undefined ? {} : { profile }),
      ...(apiOrigin === undefined ? {} : { apiOrigin }),
      timeoutMs,
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
