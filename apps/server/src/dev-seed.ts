import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  emailSchema,
  type CurrentUser,
  type Email,
  type EntityId,
  type SendConversationMessageRequest,
} from "@hype-comms/contracts";
import type { Pool, QueryResultRow } from "pg";

import { loadConfig, type ServerConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import type { EmailSender, SendMagicLinkInput } from "./modules/identity/email.js";
import { IdentityRepository, type IdentityUser } from "./modules/identity/repository.js";
import {
  IdentityService,
  type AuthenticatedIdentity,
  type SeedOwnerInput,
} from "./modules/identity/service.js";
import { WorkspaceRepository } from "./modules/workspace/repository.js";
import { SignInThrottle } from "./throttle.js";

const DEMO_SESSION_IDS = {
  claire: "30000000-0000-4000-8000-000000000001",
  woots: "30000000-0000-4000-8000-000000000002",
} as const;

const DEMO_MEMBERS = [
  {
    profile: "claire",
    email: emailSchema.parse("claire@example.test"),
    username: "claire",
    displayName: "Claire",
    sessionId: DEMO_SESSION_IDS.claire,
  },
  {
    profile: "woots",
    email: emailSchema.parse("woots@example.test"),
    username: "woots",
    displayName: "Woots",
    sessionId: DEMO_SESSION_IDS.woots,
  },
] as const;

const DEMO_OWNER: SeedOwnerInput = {
  email: DEMO_MEMBERS[0].email,
  workspaceName: "Hype Comms",
  workspaceSlug: "hype-comms",
};

const DEMO_CHANNELS = [
  {
    name: "Launch Planning",
    slug: "launch-planning",
    topic: "Coordinates the next Hype Comms launch.",
  },
  {
    name: "Design",
    slug: "design",
    topic: "Product design, prototypes, and interaction details.",
  },
  {
    name: "Random",
    slug: "random",
    topic: "The useful things that do not fit anywhere else.",
  },
] as const;

interface DemoMessageFixture {
  readonly clientMessageId: EntityId;
  readonly conversation: "general" | "launch-planning" | "design" | "random" | "direct";
  readonly author: "claire" | "woots";
  readonly body: string;
  readonly mentions?: readonly ("claire" | "woots")[];
}

const DEMO_MESSAGES: readonly DemoMessageFixture[] = [
  {
    clientMessageId: "30000000-0000-4000-8000-000000000011",
    conversation: "general",
    author: "claire",
    body: "Morning! I pulled the channel creation flow into the desktop build.",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000012",
    conversation: "general",
    author: "woots",
    body: "Nice. I’ll exercise the realtime path while you tune the interaction.",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000013",
    conversation: "launch-planning",
    author: "claire",
    body: "Let’s use this channel for the launch checklist and anything blocking the release.",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000014",
    conversation: "launch-planning",
    author: "woots",
    body: "@claire I’ve got the desktop smoke pass. I’ll post notes here.",
    mentions: ["claire"],
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000015",
    conversation: "design",
    author: "woots",
    body: "The quick-create popover feels much faster than leaving the workspace.",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000016",
    conversation: "random",
    author: "claire",
    body: "Today’s tiny victory: the demo environment finally has believable conversations.",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000017",
    conversation: "direct",
    author: "claire",
    body: "Can you try creating a channel while I watch the other client?",
  },
  {
    clientMessageId: "30000000-0000-4000-8000-000000000018",
    conversation: "direct",
    author: "woots",
    body: "Yep—opening the second window now.",
  },
] as const;

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface CapturedDemoClient {
  readonly profile: "claire" | "woots";
  readonly email: Email;
  readonly displayName: "Claire" | "Woots";
  readonly authCallbackUrl: string;
}

export interface DevelopmentDemoSeedResult {
  readonly workspaceId: EntityId;
  readonly clients: readonly CapturedDemoClient[];
  readonly channels: readonly string[];
  readonly messageCount: number;
}

interface DevelopmentDemoSeedOutput {
  readonly workspaceId: EntityId;
  readonly clients: readonly {
    readonly profile: "claire" | "woots";
    readonly email: Email;
    readonly displayName: "Claire" | "Woots";
    readonly callbackFile: string;
  }[];
  readonly channels: readonly string[];
  readonly messageCount: number;
}

class CapturingEmailSender implements EmailSender {
  sent: SendMagicLinkInput | null = null;

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.sent = input;
  }
}

function currentUser(
  user: IdentityUser,
  workspaceId: EntityId,
  role: "owner" | "member",
): CurrentUser {
  if (user.kind !== "human" || user.email === null) {
    throw new Error("A demo desktop identity must be human");
  }
  return {
    user: {
      id: user.id,
      kind: "human",
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    email: user.email,
    workspaceId,
    role,
  };
}

function identity(
  user: IdentityUser,
  workspaceId: EntityId,
  role: "owner" | "member",
  sessionId: EntityId,
): AuthenticatedIdentity {
  return {
    currentUser: currentUser(user, workspaceId, role),
    sessionId,
    principalKind: "human",
  };
}

async function ensureDemoMember(
  repository: IdentityRepository,
  workspaceId: EntityId,
  fixture: (typeof DEMO_MEMBERS)[number],
  role: "owner" | "member",
): Promise<IdentityUser> {
  let user = await repository.findUserByEmail(fixture.email);
  if (user === null) {
    const usernameOwner = await repository.findUserByUsername(fixture.username);
    if (usernameOwner !== null) {
      throw new Error(
        `Cannot seed ${fixture.displayName}: @${fixture.username} belongs to another email`,
      );
    }
    user = await repository.insertUser({
      id: randomUUID(),
      email: fixture.email,
      username: fixture.username,
      displayName: fixture.displayName,
      avatarUrl: null,
    });
  } else if (user.username !== fixture.username || user.displayName !== fixture.displayName) {
    throw new Error(
      `Cannot seed ${fixture.displayName}: ${fixture.email} already has a different identity`,
    );
  }

  await repository.upsertMembership({
    workspaceId,
    userId: user.id,
    role,
    status: "active",
  });
  return user;
}

async function findConversationId(
  pool: Pool,
  workspaceId: EntityId,
  slug: string,
): Promise<EntityId | null> {
  const result = await pool.query<IdRow>(
    `SELECT id
       FROM conversations
      WHERE workspace_id = $1 AND kind = 'channel' AND slug = $2`,
    [workspaceId, slug],
  );
  return (result.rows[0]?.id as EntityId | undefined) ?? null;
}

async function ensureChannel(
  pool: Pool,
  repository: WorkspaceRepository,
  actor: AuthenticatedIdentity,
  fixture: (typeof DEMO_CHANNELS)[number],
): Promise<EntityId> {
  const existing = await findConversationId(pool, actor.currentUser.workspaceId, fixture.slug);
  if (existing !== null) return existing;

  try {
    return (
      await repository.createChannel(actor, {
        name: fixture.name,
        slug: fixture.slug,
        topic: fixture.topic,
        access: "workspace",
      })
    ).conversation.conversation.id;
  } catch (error) {
    // Another seeder may have won the unique-slug race after our read.
    const raced = await findConversationId(pool, actor.currentUser.workspaceId, fixture.slug);
    if (raced !== null) return raced;
    throw error;
  }
}

function messageInput(
  fixture: DemoMessageFixture,
  members: ReadonlyMap<"claire" | "woots", IdentityUser>,
): SendConversationMessageRequest {
  return {
    threadRootId: null,
    body: fixture.body,
    bodyFormat: "hype_comms_markdown_v1",
    clientMessageId: fixture.clientMessageId,
    mentionedUserIds: (fixture.mentions ?? []).map((profile) => {
      const member = members.get(profile);
      if (member === undefined) throw new Error(`Unknown demo mention: ${profile}`);
      return member.id;
    }),
    attachmentIds: [],
  };
}

async function issueAuthCallback(
  repository: IdentityRepository,
  config: ServerConfig,
  fixture: (typeof DEMO_MEMBERS)[number],
): Promise<string> {
  const sender = new CapturingEmailSender();
  const service = new IdentityService(
    repository,
    sender,
    new SignInThrottle(),
    () => new Date(),
    config.publicApiUrl,
  );
  await service.requestMagicLink(fixture.email, `demo-${fixture.profile}`);
  if (sender.sent === null) {
    throw new Error(`Could not issue the ${fixture.displayName} demo sign-in link`);
  }
  const token = new URL(sender.sent.url).searchParams.get("token");
  if (token === null) throw new Error("Demo sign-in link did not contain a token");
  const callback = new URL("hype-comms-dev://auth/callback");
  callback.searchParams.set("token", token);
  return callback.toString();
}

export async function seedDevelopmentDemo(
  pool: Pool,
  config: ServerConfig,
): Promise<DevelopmentDemoSeedResult> {
  if (config.nodeEnv === "production") {
    throw new Error("Development demo data cannot be seeded in production");
  }

  const identityRepository = new IdentityRepository(pool);
  const claireFixture = DEMO_MEMBERS[0];
  const existingClaire = await identityRepository.findUserByEmail(claireFixture.email);
  if (existingClaire === null) {
    await identityRepository.insertUser({
      id: randomUUID(),
      email: claireFixture.email,
      username: claireFixture.username,
      displayName: claireFixture.displayName,
      avatarUrl: null,
    });
  } else if (
    existingClaire.username !== claireFixture.username ||
    existingClaire.displayName !== claireFixture.displayName
  ) {
    throw new Error("The demo owner identity does not match the Claire fixture");
  }
  const ownerService = new IdentityService(
    identityRepository,
    new CapturingEmailSender(),
    new SignInThrottle(),
    () => new Date(),
    config.publicApiUrl,
  );
  await ownerService.seedOwner(DEMO_OWNER);

  const workspace = await identityRepository.findWorkspaceBySlug(DEMO_OWNER.workspaceSlug);
  if (workspace === null) throw new Error("Demo workspace was not created");

  const memberUsers = new Map<"claire" | "woots", IdentityUser>();
  const identities = new Map<"claire" | "woots", AuthenticatedIdentity>();
  for (const fixture of DEMO_MEMBERS) {
    const role =
      workspace.createdBy === (await identityRepository.findUserByEmail(fixture.email))?.id
        ? "owner"
        : "member";
    const user = await ensureDemoMember(identityRepository, workspace.id, fixture, role);
    memberUsers.set(fixture.profile, user);
    identities.set(fixture.profile, identity(user, workspace.id, role, fixture.sessionId));
  }

  const claire = identities.get("claire");
  const woots = identities.get("woots");
  const wootsUser = memberUsers.get("woots");
  if (claire === undefined || woots === undefined || wootsUser === undefined) {
    throw new Error("Demo identities were not created");
  }

  const workspaceRepository = new WorkspaceRepository(pool, {
    announcementChannelsEnabled: config.announcementChannelsEnabled,
  });
  const conversationIds = new Map<DemoMessageFixture["conversation"], EntityId>();
  const generalId = await findConversationId(pool, workspace.id, "general");
  if (generalId === null) throw new Error("Demo workspace has no #general channel");
  conversationIds.set("general", generalId);
  for (const channel of DEMO_CHANNELS) {
    conversationIds.set(
      channel.slug,
      await ensureChannel(pool, workspaceRepository, claire, channel),
    );
  }
  const direct = await workspaceRepository.createDirectConversation(claire, {
    memberId: wootsUser.id,
  });
  conversationIds.set("direct", direct.conversation.conversation.id);

  for (const fixture of DEMO_MESSAGES) {
    const author = identities.get(fixture.author);
    const conversationId = conversationIds.get(fixture.conversation);
    if (author === undefined || conversationId === undefined) {
      throw new Error(`Invalid demo message fixture ${fixture.clientMessageId}`);
    }
    await workspaceRepository.sendMessage(
      author,
      conversationId,
      messageInput(fixture, memberUsers),
    );
  }

  const clients: CapturedDemoClient[] = [];
  for (const fixture of DEMO_MEMBERS) {
    clients.push({
      profile: fixture.profile,
      email: fixture.email,
      displayName: fixture.displayName,
      authCallbackUrl: await issueAuthCallback(identityRepository, config, fixture),
    });
  }

  return {
    workspaceId: workspace.id,
    clients,
    channels: ["general", ...DEMO_CHANNELS.map((channel) => channel.slug)],
    messageCount: DEMO_MESSAGES.length,
  };
}

export async function writeDevelopmentDemoCallbacks(
  result: DevelopmentDemoSeedResult,
  callbackDirectory: string,
): Promise<DevelopmentDemoSeedOutput> {
  const directory = path.resolve(callbackDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const clients: DevelopmentDemoSeedOutput["clients"][number][] = [];
  for (const client of result.clients) {
    const callbackFile = path.join(directory, `${client.profile}.callback`);
    await rm(callbackFile, { force: true });
    const handle = await open(callbackFile, "wx", 0o600);
    try {
      await handle.writeFile(`${client.authCallbackUrl}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(callbackFile, 0o600);
    clients.push({
      profile: client.profile,
      email: client.email,
      displayName: client.displayName,
      callbackFile,
    });
  }
  return {
    workspaceId: result.workspaceId,
    clients,
    channels: result.channels,
    messageCount: result.messageCount,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.database === undefined) {
    throw new Error("HYPE_COMMS_DATABASE_URL is required to seed the development demo");
  }
  const pool = createPool(config.database);
  try {
    await runMigrations(pool);
    const result = await seedDevelopmentDemo(pool, config);
    const callbackDirectory = process.env.HYPE_COMMS_DEMO_CALLBACK_DIRECTORY?.trim() ?? "";
    if (callbackDirectory === "") {
      throw new Error(
        "HYPE_COMMS_DEMO_CALLBACK_DIRECTORY is required to seed the development demo",
      );
    }
    const output = await writeDevelopmentDemoCallbacks(result, callbackDirectory);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    await pool.end();
  }
}

const entryPoint = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown demo seed failure";
    process.stderr.write(`Demo seed failed: ${message}\n`);
    process.exitCode = 1;
  });
}
