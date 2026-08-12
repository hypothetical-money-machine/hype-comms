import path from "node:path";
import { pathToFileURL } from "node:url";

import { emailSchema, type Email, type Invitation } from "@hype-comms/contracts";
import { z } from "zod";

import { loadConfig } from "../../config.js";
import { runMigrations } from "../../db/migrate.js";
import { createPool } from "../../db/pool.js";
import { ApiError } from "../../errors.js";
import { SignInThrottle } from "../../throttle.js";
import type { EmailSender, SendMagicLinkInput } from "./email.js";
import { IdentityRepository } from "./repository.js";
import { IdentityService } from "./service.js";

const USAGE =
  "Usage: npm run invite --workspace @hype-comms/server -- --email <address> [--role member]";
const CLI_CLIENT_IP = "invite-cli";

export interface InviteCliOutput {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

interface InviteArguments {
  readonly email: Email;
  readonly role: "member";
}

class CapturingEmailSender implements EmailSender {
  captured: SendMagicLinkInput | null = null;

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.captured = input;
  }
}

function parseArguments(argv: readonly string[]): InviteArguments {
  let email: string | undefined;
  let role: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--email" && flag !== "--role") {
      throw new Error(`Unknown argument: ${flag ?? ""}\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}\n${USAGE}`);
    }
    if (flag === "--email") {
      if (email !== undefined) throw new Error(`--email may only be specified once\n${USAGE}`);
      email = value;
    } else {
      if (role !== undefined) throw new Error(`--role may only be specified once\n${USAGE}`);
      role = value;
    }
    index += 1;
  }

  if (email === undefined) throw new Error(`--email is required\n${USAGE}`);
  const emailResult = emailSchema.safeParse(email);
  if (!emailResult.success) throw new Error(`Invalid email address\n${USAGE}`);
  const roleResult = z.literal("member").safeParse(role ?? "member");
  if (!roleResult.success) throw new Error(`--role must be member\n${USAGE}`);
  return { email: emailResult.data, role: roleResult.data };
}

async function createOrReuseInvitation(
  service: IdentityService,
  repository: IdentityRepository,
  ownerUserId: Parameters<IdentityService["createInvitation"]>[0],
  input: InviteArguments,
): Promise<{ invitation: Invitation; reused: boolean }> {
  const existing = await repository.findPendingInvitationByEmail(input.email);
  if (existing !== null && Date.parse(existing.expiresAt) > Date.now()) {
    return { invitation: existing, reused: true };
  }

  try {
    return {
      invitation: await service.createInvitation(ownerUserId, input.email, input.role),
      reused: false,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) {
      const invitation = await repository.findPendingInvitationByEmail(input.email);
      if (invitation !== null && Date.parse(invitation.expiresAt) > Date.now()) {
        return { invitation, reused: true };
      }
    }
    throw error;
  }
}

export async function runInviteCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: InviteCliOutput,
): Promise<number> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    if (env.HYPE_COMMS_DATABASE_URL === undefined || env.HYPE_COMMS_DATABASE_URL === "") {
      throw new Error("HYPE_COMMS_DATABASE_URL is required");
    }
    const input = parseArguments(argv);
    const config = loadConfig(env);
    if (config.database === undefined) throw new Error("HYPE_COMMS_DATABASE_URL is required");

    pool = createPool(config.database);
    await runMigrations(pool);
    const repository = new IdentityRepository(pool);
    const workspace = await repository.findFirstWorkspace();
    const owner =
      workspace === null ? null : await repository.findActiveOwnerMembership(workspace.id);
    if (workspace === null || owner === null) {
      throw new Error(
        "No seeded workspace owner was found. Set HYPE_COMMS_OWNER_EMAIL and start the server once to seed it.",
      );
    }
    const existingUser = await repository.findUserByEmail(input.email);
    const membership =
      existingUser === null ? null : await repository.findMembership(workspace.id, existingUser.id);
    const activeMembership = membership?.status === "active" ? membership : null;

    const sender = new CapturingEmailSender();
    const service = new IdentityService(
      repository,
      sender,
      new SignInThrottle(),
      () => new Date(),
      config.publicApiUrl,
    );
    const invitationResult =
      activeMembership === null
        ? await createOrReuseInvitation(service, repository, owner.userId, input)
        : null;
    // requestMagicLink answers identically whether or not it issued a link, and swallows failures
    // so that the HTTP path cannot leak which addresses are real. For an operator command that
    // silence is unhelpful, so surface the underlying cause on stderr.
    await service.requestMagicLink(input.email, CLI_CLIENT_IP, {
      error: (details, message) => {
        const cause = details.err;
        const reason = cause instanceof Error ? cause.message : "unknown cause";
        output.stderr.write(`${message}: ${reason}\n`);
      },
    });
    const captured = sender.captured;
    if (captured === null) {
      throw new Error(
        "No magic link was produced. Verify that the membership is active or the invitation is pending and has not expired.",
      );
    }

    if (activeMembership === null) {
      if (invitationResult === null) throw new Error("Invitation was not created");
      output.stdout.write(`Invited: ${input.email}\n`);
      output.stdout.write(`Role: ${input.role}\n`);
      output.stdout.write(`Invitation expires: ${invitationResult.invitation.expiresAt}\n`);
      if (invitationResult.reused) {
        output.stdout.write("Existing pending invitation reused.\n");
      }
    } else {
      output.stdout.write(`Existing member: ${input.email}\n`);
      output.stdout.write(`Current role: ${activeMembership.role}\n`);
    }
    output.stdout.write(`Magic link expires: ${captured.expiresAt.toISOString()}\n`);
    output.stdout.write(
      "Warning: this link grants access. Send it only through a private channel.\n",
    );
    output.stdout.write(`${captured.url}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown invitation failure";
    output.stderr.write(`Invite failed: ${message}\n`);
    return 1;
  } finally {
    await pool?.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  runInviteCli(process.argv.slice(2), process.env, {
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
