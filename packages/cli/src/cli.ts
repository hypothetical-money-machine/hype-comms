import { agentTokensCommand, agentsCommand, invitationsCommand } from "./commands/admin.js";
import { authCommand } from "./commands/auth.js";
import { agentEnrollmentPolicyCommand, agentEnrollmentsCommand } from "./commands/enrollments.js";
import { filesCommand } from "./commands/files.js";
import { profilesCommand } from "./commands/profiles.js";
import { health, readiness } from "./commands/system.js";
import {
  channelsCommand,
  conversationsCommand,
  dmsCommand,
  messagesCommand,
  readCursorsCommand,
  syncCommand,
  workspaceCommand,
} from "./commands/workspace.js";
import { extractGlobalOptions } from "./argv.js";
import { asCliError, EXIT_SUCCESS, UsageError, type CliExitCode } from "./errors.js";
import { writeError, writeResult } from "./output.js";
import type { CommandContext, Runtime } from "./types.js";
import { wakeCommand } from "./wake.js";
import { watchCommand } from "./watch.js";

export const HELP = `hype-comms-cli - Hype Comms command-line client

Usage:
  hype-comms-cli [global-options] <command> [command-options]

Global options:
  --json                    Emit JSON results (watch emits NDJSON)
  --profile NAME            Select a named profile
  --api-origin URL          Override the profile API origin
  --timeout-ms MS           Request timeout (default: 30000)

Commands:
  health
  readiness
  profiles list
  profiles show [NAME]
  profiles set NAME --api-origin URL [--default]
  profiles use NAME
  profiles remove NAME
  auth request-magic-link EMAIL
  auth exchange                         Read magic-link token privately
  auth login-agent [--save]             Read agent token privately or from HYPE_COMMS_TOKEN
  auth whoami
  auth refresh
  auth logout
  auth devices list
  auth devices revoke DEVICE_ID
  workspace bootstrap
  workspace members
  conversations list [--after CURSOR] [--limit N] [--all]
  channels list [--after CURSOR] [--limit N]
  channels join CHANNEL
  channels create NAME [--slug SLUG] [--topic TOPIC]
  channels archive CHANNEL
  dms create MEMBER
  dms create-group MEMBER MEMBER [MEMBER...] [--idempotency-key KEY]
  messages get MESSAGE_ID
  messages history CONVERSATION [--before CURSOR] [--limit N]
  messages history CONVERSATION --context-pack [--through-message-id UUID]
                [--before CURSOR] [--limit N]
  messages send CONVERSATION [BODY] [--file PATH] [--mention MEMBER]...
                [--client-message-id UUID] [--thread-root-id UUID]
  files list CONVERSATION [--before CURSOR] [--limit N]
  files for-message MESSAGE_ID
  files get ATTACHMENT_ID --output PATH
  agent-enrollments offer USERNAME --display-name NAME --label LABEL
                    [--restricted-channel-id UUID]...
  agent-enrollments offer --resume
  agent-enrollments request USERNAME --display-name NAME --label LABEL
                    --credential-verifier VERIFIER [--restricted-channel-id UUID]...
                    [--idempotency-key KEY]
  agent-enrollments status ENROLLMENT_ID
  agent-enrollments cancel ENROLLMENT_ID
  agent-enrollments list
  agent-enrollments approve ENROLLMENT_ID
  agent-enrollments reject ENROLLMENT_ID
  agent-enrollments redeem ENROLLMENT_ID
  agent-enrollment-policy show
  agent-enrollment-policy set <required|automatic>
  read-cursors advance CONVERSATION MESSAGE_ID
  sync --after CURSOR [--limit N]
  watch --json [--after CURSOR]
  wake watch --json [--after CURSOR]
  invitations list
  invitations create EMAIL
  invitations revoke INVITATION_ID
  agents list
  agents create USERNAME --display-name NAME
  agents disable AGENT
  agent-tokens list AGENT
  agent-tokens create AGENT --label LABEL [--scope SCOPE]...
  agent-tokens revoke AGENT TOKEN_ID

Environment:
  HYPE_COMMS_API_ORIGIN, HYPE_COMMS_TOKEN, HYPE_COMMS_PROFILE, HYPE_COMMS_CONFIG_DIR

Credentials are never accepted as command arguments.`;

export const VERSION = "0.1.0";

export async function runCli(argv: readonly string[], runtime: Runtime): Promise<void> {
  const extracted = extractGlobalOptions(argv);
  const [command, subcommand, ...rest] = extracted.args;
  const context: CommandContext = { runtime, options: extracted.options };

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    writeResult(runtime.io, HELP, extracted.options.json);
    return;
  }
  if (command === "--version" || command === "version") {
    writeResult(runtime.io, { version: VERSION }, extracted.options.json);
    return;
  }
  if (command === "health") {
    if (subcommand !== undefined) throw new UsageError("health does not accept arguments");
    await health(context);
    return;
  }
  if (command === "readiness") {
    if (subcommand !== undefined) throw new UsageError("readiness does not accept arguments");
    await readiness(context);
    return;
  }
  if (command === "profiles") {
    await profilesCommand(context, subcommand, rest);
    return;
  }
  if (command === "auth") {
    await authCommand(context, subcommand, rest);
    return;
  }
  if (command === "workspace") {
    await workspaceCommand(context, subcommand, rest);
    return;
  }
  if (command === "conversations") {
    await conversationsCommand(context, subcommand, rest);
    return;
  }
  if (command === "channels") {
    await channelsCommand(context, subcommand, rest);
    return;
  }
  if (command === "dms") {
    await dmsCommand(context, subcommand, rest);
    return;
  }
  if (command === "messages") {
    await messagesCommand(context, subcommand, rest);
    return;
  }
  if (command === "files") {
    await filesCommand(context, subcommand, rest);
    return;
  }
  if (command === "agent-enrollments") {
    await agentEnrollmentsCommand(context, subcommand, rest);
    return;
  }
  if (command === "agent-enrollment-policy") {
    await agentEnrollmentPolicyCommand(context, subcommand, rest);
    return;
  }
  if (command === "read-cursors") {
    await readCursorsCommand(context, subcommand, rest);
    return;
  }
  if (command === "sync") {
    if (subcommand !== undefined) {
      await syncCommand(context, [subcommand, ...rest]);
    } else {
      await syncCommand(context, rest);
    }
    return;
  }
  if (command === "watch") {
    if (subcommand !== undefined) {
      await watchCommand(context, [subcommand, ...rest]);
    } else {
      await watchCommand(context, rest);
    }
    return;
  }
  if (command === "wake") {
    await wakeCommand(context, subcommand, rest);
    return;
  }
  if (command === "invitations") {
    await invitationsCommand(context, subcommand, rest);
    return;
  }
  if (command === "agents") {
    await agentsCommand(context, subcommand, rest);
    return;
  }
  if (command === "agent-tokens") {
    await agentTokensCommand(context, subcommand, rest);
    return;
  }
  throw new UsageError(`Unknown command ${command}`);
}

export async function executeCli(argv: readonly string[], runtime: Runtime): Promise<CliExitCode> {
  try {
    await runCli(argv, runtime);
    return EXIT_SUCCESS;
  } catch (error) {
    const cliError = asCliError(error);
    writeError(runtime.io, cliError, argv.includes("--json"));
    return cliError.exitCode;
  }
}
