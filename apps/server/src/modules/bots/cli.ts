import path from "node:path";
import { pathToFileURL } from "node:url";

import { botScopeSchema, type BotScope } from "@hype-comms/contracts";

import { loadConfig } from "../../config.js";
import { runMigrations } from "../../db/migrate.js";
import { createPool } from "../../db/pool.js";
import { IdentityRepository } from "../identity/repository.js";
import { BotService, botDisplayNameSchema, botUsernameSchema } from "./service.js";

const DEFAULT_EXPIRY_DAYS = 90;
const DEFAULT_SCOPES = ["tasks:read", "tasks:write"] as const satisfies readonly BotScope[];
const USAGE = `Usage:
  npm run bot --workspace @hype-comms/server -- create --username <handle> --display-name <name> --channel <slug> [--channel <slug>] [--scope tasks:read|tasks:write] [--expires-in-days 90]
  npm run bot --workspace @hype-comms/server -- grant --username <handle> --channel <slug> [--channel <slug>]
  npm run bot --workspace @hype-comms/server -- rotate --username <handle> [--scope tasks:read|tasks:write] [--expires-in-days 90]
  npm run bot --workspace @hype-comms/server -- revoke --username <handle>
  npm run bot --workspace @hype-comms/server -- list`;

export interface BotCliOutput {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

type BotCommand =
  | {
      readonly name: "create";
      readonly username: string;
      readonly displayName: string;
      readonly channelSlugs: readonly string[];
      readonly scopes: readonly BotScope[];
      readonly expiresInDays: number;
    }
  | {
      readonly name: "grant";
      readonly username: string;
      readonly channelSlugs: readonly string[];
    }
  | {
      readonly name: "rotate";
      readonly username: string;
      readonly scopes: readonly BotScope[];
      readonly expiresInDays: number;
    }
  | { readonly name: "revoke"; readonly username: string }
  | { readonly name: "list" };

interface ParsedFlags {
  readonly usernames: string[];
  readonly displayNames: string[];
  readonly channelSlugs: string[];
  readonly scopes: string[];
  readonly expiryDays: string[];
}

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

function flags(argv: readonly string[]): ParsedFlags {
  const parsed: {
    usernames: string[];
    displayNames: string[];
    channelSlugs: string[];
    scopes: string[];
    expiryDays: string[];
  } = { usernames: [], displayNames: [], channelSlugs: [], scopes: [], expiryDays: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--")
    ) {
      fail(`Missing value for ${flag ?? "argument"}`);
    }
    switch (flag) {
      case "--username":
        parsed.usernames.push(value);
        break;
      case "--display-name":
        parsed.displayNames.push(value);
        break;
      case "--channel":
        parsed.channelSlugs.push(value);
        break;
      case "--scope":
        parsed.scopes.push(value);
        break;
      case "--expires-in-days":
        parsed.expiryDays.push(value);
        break;
      default:
        fail(`Unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function exactlyOne(values: readonly string[], flag: string): string {
  if (values.length !== 1) fail(`${flag} is required exactly once`);
  return values[0] as string;
}

function none(values: readonly string[], flag: string): void {
  if (values.length !== 0) fail(`${flag} is not valid for this command`);
}

function scopes(values: readonly string[]): BotScope[] {
  const inputs = values.length === 0 ? DEFAULT_SCOPES : values;
  const parsed = inputs.map((value) => {
    const result = botScopeSchema.safeParse(value);
    if (!result.success) fail(`Invalid bot scope: ${value}`);
    return result.data;
  });
  if (new Set(parsed).size !== parsed.length) fail("Each --scope may be specified only once");
  return parsed;
}

function expiryDays(values: readonly string[]): number {
  if (values.length > 1) fail("--expires-in-days may only be specified once");
  const raw = values[0] ?? String(DEFAULT_EXPIRY_DAYS);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    fail("--expires-in-days must be an integer from 1 to 365");
  }
  return value;
}

function username(values: readonly string[]): string {
  const result = botUsernameSchema.safeParse(exactlyOne(values, "--username"));
  if (!result.success) fail("--username must be a lowercase hyphenated handle");
  return result.data;
}

function parseCommand(argv: readonly string[]): BotCommand {
  const [commandName, ...argumentValues] = argv;
  if (commandName === "list") {
    if (argumentValues.length !== 0) fail("list does not accept arguments");
    return { name: "list" };
  }
  if (
    !(["create", "grant", "rotate", "revoke"] as const).includes(
      commandName as "create" | "grant" | "rotate" | "revoke",
    )
  ) {
    fail("A bot command is required");
  }
  const parsed = flags(argumentValues);
  const parsedUsername = username(parsed.usernames);
  if (commandName === "create") {
    const displayNameResult = botDisplayNameSchema.safeParse(
      exactlyOne(parsed.displayNames, "--display-name"),
    );
    if (!displayNameResult.success) fail("--display-name must contain 1 to 80 characters");
    if (parsed.channelSlugs.length === 0) fail("At least one --channel is required");
    return {
      name: "create",
      username: parsedUsername,
      displayName: displayNameResult.data,
      channelSlugs: parsed.channelSlugs,
      scopes: scopes(parsed.scopes),
      expiresInDays: expiryDays(parsed.expiryDays),
    };
  }
  none(parsed.displayNames, "--display-name");
  if (commandName === "grant") {
    none(parsed.scopes, "--scope");
    none(parsed.expiryDays, "--expires-in-days");
    if (parsed.channelSlugs.length === 0) fail("At least one --channel is required");
    return { name: "grant", username: parsedUsername, channelSlugs: parsed.channelSlugs };
  }
  none(parsed.channelSlugs, "--channel");
  if (commandName === "rotate") {
    return {
      name: "rotate",
      username: parsedUsername,
      scopes: scopes(parsed.scopes),
      expiresInDays: expiryDays(parsed.expiryDays),
    };
  }
  none(parsed.scopes, "--scope");
  none(parsed.expiryDays, "--expires-in-days");
  return { name: "revoke", username: parsedUsername };
}

function expiresAt(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function printCredential(
  output: BotCliOutput,
  issued: Awaited<ReturnType<BotService["createBot"]>>,
) {
  output.stdout.write(`Bot: ${issued.bot.displayName} (@${issued.bot.username})\n`);
  output.stdout.write(`Credential: ${issued.credentialId}\n`);
  output.stdout.write(`Scopes: ${issued.scopes.join(", ")}\n`);
  output.stdout.write(`Expires: ${issued.expiresAt}\n`);
  output.stdout.write("Token (shown once):\n");
  output.stdout.write(`${issued.token}\n`);
  output.stdout.write("Send it only as an Authorization: Bearer credential.\n");
}

export async function runBotCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: BotCliOutput,
): Promise<number> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    if (env.HYPE_COMMS_DATABASE_URL === undefined || env.HYPE_COMMS_DATABASE_URL === "") {
      throw new Error("HYPE_COMMS_DATABASE_URL is required");
    }
    const command = parseCommand(argv);
    const config = loadConfig(env);
    if (config.database === undefined) throw new Error("HYPE_COMMS_DATABASE_URL is required");
    pool = createPool(config.database);
    await runMigrations(pool);
    const identityRepository = new IdentityRepository(pool);
    const workspace = await identityRepository.findFirstWorkspace();
    const owner =
      workspace === null ? null : await identityRepository.findActiveOwnerMembership(workspace.id);
    if (workspace === null || owner === null) {
      throw new Error(
        "No seeded workspace owner was found. Set HYPE_COMMS_OWNER_EMAIL and start the server once to seed it.",
      );
    }
    const now = new Date();
    const service = new BotService(pool, () => now);
    switch (command.name) {
      case "create": {
        const issued = await service.createBot(owner.userId, {
          username: command.username,
          displayName: command.displayName,
          channelSlugs: command.channelSlugs,
          scopes: command.scopes,
          expiresAt: expiresAt(now, command.expiresInDays),
        });
        printCredential(output, issued);
        break;
      }
      case "grant": {
        const added = await service.grantChannels(
          owner.userId,
          command.username,
          command.channelSlugs,
        );
        output.stdout.write(`Granted ${added} new channel${added === 1 ? "" : "s"}.\n`);
        break;
      }
      case "rotate": {
        const issued = await service.rotateCredential(owner.userId, {
          username: command.username,
          scopes: command.scopes,
          expiresAt: expiresAt(now, command.expiresInDays),
        });
        output.stdout.write("All prior credentials for this bot were revoked.\n");
        printCredential(output, issued);
        break;
      }
      case "revoke": {
        const revoked = await service.revokeCredentials(owner.userId, command.username);
        output.stdout.write(`Revoked ${revoked} active credential${revoked === 1 ? "" : "s"}.\n`);
        break;
      }
      case "list": {
        const bots = await service.listBots(owner.userId);
        if (bots.length === 0) {
          output.stdout.write("No bots.\n");
          break;
        }
        for (const bot of bots) {
          output.stdout.write(
            `@${bot.bot.username}\t${bot.bot.displayName}\tcredentials=${bot.activeCredentials}\tchannels=${bot.channelSlugs.join(",")}\n`,
          );
        }
        break;
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown bot-management failure";
    output.stderr.write(`Bot command failed: ${message}\n`);
    return 1;
  } finally {
    await pool?.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  runBotCli(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
