import { developmentIdentityNameSchema, type DevelopmentIdentity } from "@hmm-chat/contracts";

export class DevelopmentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentIdentityError";
  }
}

function readNameArgument(argv: readonly string[]): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--name") {
      const next = argv[index + 1];
      if (value !== undefined || next === undefined || next.startsWith("--")) {
        throw new DevelopmentIdentityError("--name requires exactly one value");
      }
      value = next;
      index += 1;
      continue;
    }

    if (argument?.startsWith("--name=")) {
      if (value !== undefined) {
        throw new DevelopmentIdentityError("--name can only be provided once");
      }
      value = argument.slice("--name=".length);
    }
  }

  return value;
}

export function resolveDevelopmentIdentity(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fallbackName?: string,
): DevelopmentIdentity {
  const argumentName = readNameArgument(argv);
  const result = developmentIdentityNameSchema.safeParse(
    argumentName ?? env.HMM_CHAT_NAME ?? fallbackName,
  );

  if (!result.success) {
    throw new DevelopmentIdentityError(
      "A valid identity is required. Start with: npm run dev -- --name <display-name>",
    );
  }

  return { name: result.data };
}
