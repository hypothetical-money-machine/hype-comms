import { randomBytes, randomUUID } from "node:crypto";

import {
  botAccessTokenSchema,
  botScopesSchema,
  channelSlugSchema,
  entityIdSchema,
  isoDateTimeSchema,
  userSchema,
  type BotAccessToken,
  type BotScope,
  type EntityId,
  type User,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { withTransaction } from "../../db/pool.js";
import { ApiError } from "../../errors.js";
import { hashToken } from "../identity/tokens.js";

const MAX_ACTIVE_MEMBERS = 25;

export const botUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase bot handle");

export const botDisplayNameSchema = z.string().trim().min(1).max(80);

interface BotAuthenticationRow extends QueryResultRow {
  readonly credential_id: unknown;
  readonly workspace_id: unknown;
  readonly bot_user_id: unknown;
  readonly scopes: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface BotUserRow extends QueryResultRow {
  readonly id: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface BotSummaryRow extends BotUserRow {
  readonly workspace_id: unknown;
  readonly active_credentials: unknown;
  readonly channel_slugs: unknown;
}

interface WorkspaceIdRow extends QueryResultRow {
  readonly workspace_id: unknown;
}

interface ChannelRow extends QueryResultRow {
  readonly id: unknown;
  readonly slug: unknown;
  readonly channel_mode: unknown;
}

const workspaceIdRowSchema = z.object({ workspace_id: entityIdSchema }).strict();
const channelRowSchema = z
  .object({
    id: entityIdSchema,
    slug: channelSlugSchema,
    channel_mode: z.enum(["chat", "announcement"]),
  })
  .strict();
const botAuthenticationRowSchema = z
  .object({
    credential_id: entityIdSchema,
    workspace_id: entityIdSchema,
    bot_user_id: entityIdSchema,
    scopes: botScopesSchema,
    username: botUsernameSchema,
    display_name: botDisplayNameSchema,
    avatar_url: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
  })
  .strict();
const botSummaryRowSchema = z
  .object({
    id: entityIdSchema,
    workspace_id: entityIdSchema,
    username: botUsernameSchema,
    display_name: botDisplayNameSchema,
    avatar_url: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
    active_credentials: z.coerce.number().int().nonnegative(),
    channel_slugs: z.array(channelSlugSchema),
  })
  .strict();

export interface AuthenticatedBotIdentity {
  readonly principalKind: "bot";
  readonly currentUser: {
    readonly user: User;
    readonly workspaceId: EntityId;
    readonly role: "member";
  };
  readonly sessionId: null;
  readonly credentialId: EntityId;
  readonly scopes: readonly BotScope[];
}

export interface CreateBotInput {
  readonly username: string;
  readonly displayName: string;
  readonly channelSlugs: readonly string[];
  readonly scopes: readonly BotScope[];
  readonly expiresAt: string;
}

export interface IssueBotCredentialInput {
  readonly username: string;
  readonly scopes: readonly BotScope[];
  readonly expiresAt: string;
}

export interface IssuedBotCredential {
  readonly bot: User;
  readonly credentialId: EntityId;
  readonly token: BotAccessToken;
  readonly scopes: readonly BotScope[];
  readonly expiresAt: string;
}

export interface BotSummary {
  readonly bot: User;
  readonly workspaceId: EntityId;
  readonly activeCredentials: number;
  readonly channelSlugs: readonly string[];
}

function timestamp(value: unknown): string {
  if (!(value instanceof Date)) {
    throw new TypeError("Expected Postgres to return a timestamptz value as a Date");
  }
  return value.toISOString();
}

function mapBot(row: BotUserRow): User {
  return userSchema.parse({
    id: row.id,
    kind: "bot",
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function issueBotToken(): { readonly token: BotAccessToken; readonly hash: Buffer } {
  const token = botAccessTokenSchema.parse(
    `hype_comms_bot_${randomBytes(32).toString("base64url")}`,
  );
  return { token, hash: hashToken(token) };
}

function normalizedScopes(scopes: readonly BotScope[]): BotScope[] {
  return botScopesSchema.parse([...new Set(scopes)].sort());
}

function futureExpiry(value: string, now: Date): string {
  const parsed = isoDateTimeSchema.parse(value);
  if (Date.parse(parsed) <= now.getTime()) {
    throw new ApiError(400, "BAD_REQUEST", "Bot credentials must expire in the future");
  }
  return parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

/** Owner-operated bot identities and task-scoped service credentials. */
export class BotService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async authenticate(token: string): Promise<AuthenticatedBotIdentity | null> {
    const parsedToken = botAccessTokenSchema.safeParse(token);
    if (!parsedToken.success) return null;
    const usedAt = this.clock();
    const result = await this.pool.query<BotAuthenticationRow>(
      `UPDATE bot_credentials AS credential
          SET last_used_at = $2
         FROM users AS user_account,
              workspace_memberships AS membership
        WHERE credential.token_hash = $1
          AND credential.revoked_at IS NULL
          AND credential.expires_at > $2
          AND user_account.id = credential.bot_user_id
          AND user_account.kind = 'bot'
          AND membership.workspace_id = credential.workspace_id
          AND membership.user_id = credential.bot_user_id
          AND membership.role = 'member'
          AND membership.status = 'active'
        RETURNING credential.id AS credential_id,
                  credential.workspace_id,
                  credential.bot_user_id,
                  credential.scopes,
                  user_account.username,
                  user_account.display_name,
                  user_account.avatar_url,
                  user_account.created_at,
                  user_account.updated_at`,
      [hashToken(parsedToken.data), usedAt],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const authenticated = botAuthenticationRowSchema.parse(row);
    return {
      principalKind: "bot",
      currentUser: {
        user: userSchema.parse({
          id: authenticated.bot_user_id,
          kind: "bot",
          username: authenticated.username,
          displayName: authenticated.display_name,
          avatarUrl: authenticated.avatar_url,
          createdAt: authenticated.created_at.toISOString(),
          updatedAt: authenticated.updated_at.toISOString(),
        }),
        workspaceId: authenticated.workspace_id,
        role: "member",
      },
      sessionId: null,
      credentialId: authenticated.credential_id,
      scopes: authenticated.scopes,
    };
  }

  async createBot(actorUserId: EntityId, input: CreateBotInput): Promise<IssuedBotCredential> {
    const now = this.clock();
    const username = botUsernameSchema.parse(input.username);
    const displayName = botDisplayNameSchema.parse(input.displayName);
    const scopes = normalizedScopes(input.scopes);
    const expiresAt = futureExpiry(input.expiresAt, now);
    const channelSlugs = [
      ...new Set(input.channelSlugs.map((slug) => channelSlugSchema.parse(slug))),
    ];
    if (channelSlugs.length === 0) {
      throw new ApiError(400, "BAD_REQUEST", "Grant the bot at least one channel");
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        const workspaceId = await this.#requireOwner(client, actorUserId);
        const capacity = await client.query<{ count: number } & QueryResultRow>(
          `SELECT count(*)::integer AS count
             FROM workspace_memberships
            WHERE workspace_id = $1
              AND status = 'active'`,
          [workspaceId],
        );
        if ((capacity.rows[0]?.count ?? MAX_ACTIVE_MEMBERS) >= MAX_ACTIVE_MEMBERS) {
          throw new ApiError(409, "CONFLICT", "The workspace is at capacity");
        }
        const channels = await this.#channels(client, workspaceId, channelSlugs);
        const botId = entityIdSchema.parse(randomUUID());
        const inserted = await client.query<BotUserRow>(
          `INSERT INTO users (id, email, kind, username, display_name, avatar_url)
           VALUES ($1, NULL, 'bot', $2, $3, NULL)
           RETURNING id, username, display_name, avatar_url, created_at, updated_at`,
          [botId, username, displayName],
        );
        const botRow = inserted.rows[0];
        if (botRow === undefined) throw new Error("Bot insert returned no row");
        await client.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')`,
          [workspaceId, botId],
        );
        await client.query(
          `INSERT INTO bot_channel_grants
             (workspace_id, bot_user_id, conversation_id, granted_by)
           SELECT $1, $2, channel.id, $3
             FROM unnest($4::uuid[]) AS channel(id)`,
          [workspaceId, botId, actorUserId, channels.map((channel) => channel.id)],
        );
        return this.#insertCredential(client, {
          workspaceId,
          bot: mapBot(botRow),
          scopes,
          expiresAt,
          actorUserId,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "CONFLICT", "That bot username is already in use");
      }
      throw error;
    }
  }

  async rotateCredential(
    actorUserId: EntityId,
    input: IssueBotCredentialInput,
  ): Promise<IssuedBotCredential> {
    const now = this.clock();
    const username = botUsernameSchema.parse(input.username);
    const scopes = normalizedScopes(input.scopes);
    const expiresAt = futureExpiry(input.expiresAt, now);
    return withTransaction(this.pool, async (client) => {
      const workspaceId = await this.#requireOwner(client, actorUserId);
      const bot = await this.#requireBot(client, workspaceId, username, true);
      await client.query(
        `UPDATE bot_credentials
            SET revoked_at = $3
          WHERE workspace_id = $1
            AND bot_user_id = $2
            AND revoked_at IS NULL`,
        [workspaceId, bot.id, now],
      );
      return this.#insertCredential(client, {
        workspaceId,
        bot,
        scopes,
        expiresAt,
        actorUserId,
      });
    });
  }

  async revokeCredentials(actorUserId: EntityId, usernameInput: string): Promise<number> {
    const username = botUsernameSchema.parse(usernameInput);
    const now = this.clock();
    return withTransaction(this.pool, async (client) => {
      const workspaceId = await this.#requireOwner(client, actorUserId);
      const bot = await this.#requireBot(client, workspaceId, username, true);
      const result = await client.query(
        `UPDATE bot_credentials
            SET revoked_at = $3
          WHERE workspace_id = $1
            AND bot_user_id = $2
            AND revoked_at IS NULL`,
        [workspaceId, bot.id, now],
      );
      return result.rowCount ?? 0;
    });
  }

  async grantChannels(
    actorUserId: EntityId,
    usernameInput: string,
    channelSlugInputs: readonly string[],
  ): Promise<number> {
    const username = botUsernameSchema.parse(usernameInput);
    const channelSlugs = [
      ...new Set(channelSlugInputs.map((slug) => channelSlugSchema.parse(slug))),
    ];
    if (channelSlugs.length === 0) {
      throw new ApiError(400, "BAD_REQUEST", "Specify at least one channel");
    }
    return withTransaction(this.pool, async (client) => {
      const workspaceId = await this.#requireOwner(client, actorUserId);
      const bot = await this.#requireBot(client, workspaceId, username, true);
      const channels = await this.#channels(client, workspaceId, channelSlugs);
      const result = await client.query(
        `INSERT INTO bot_channel_grants
           (workspace_id, bot_user_id, conversation_id, granted_by)
         SELECT $1, $2, channel.id, $3
           FROM unnest($4::uuid[]) AS channel(id)
         ON CONFLICT (bot_user_id, conversation_id) DO NOTHING`,
        [workspaceId, bot.id, actorUserId, channels.map((channel) => channel.id)],
      );
      return result.rowCount ?? 0;
    });
  }

  async listBots(actorUserId: EntityId): Promise<BotSummary[]> {
    return withTransaction(this.pool, async (client) => {
      const workspaceId = await this.#requireOwner(client, actorUserId);
      const result = await client.query<BotSummaryRow>(
        `SELECT user_account.id,
                  membership.workspace_id,
                  user_account.username,
                  user_account.display_name,
                  user_account.avatar_url,
                  user_account.created_at,
                  user_account.updated_at,
                  count(DISTINCT credential.id) FILTER (
                    WHERE credential.revoked_at IS NULL
                      AND credential.expires_at > $2
                  )::integer AS active_credentials,
                  coalesce(
                    array_agg(DISTINCT conversation.slug ORDER BY conversation.slug)
                      FILTER (WHERE conversation.slug IS NOT NULL),
                    ARRAY[]::text[]
                  ) AS channel_slugs
             FROM users AS user_account
             JOIN workspace_memberships AS membership
               ON membership.user_id = user_account.id
              AND membership.workspace_id = $1
              AND membership.status = 'active'
             LEFT JOIN bot_credentials AS credential
               ON credential.workspace_id = membership.workspace_id
              AND credential.bot_user_id = user_account.id
             LEFT JOIN bot_channel_grants AS grant_record
               ON grant_record.workspace_id = membership.workspace_id
              AND grant_record.bot_user_id = user_account.id
             LEFT JOIN conversations AS conversation
               ON conversation.id = grant_record.conversation_id
            WHERE user_account.kind = 'bot'
            GROUP BY user_account.id, membership.workspace_id
            ORDER BY lower(user_account.display_name), user_account.id`,
        [workspaceId, this.clock()],
      );
      return result.rows.map((raw) => {
        const row = botSummaryRowSchema.parse(raw);
        return {
          bot: mapBot(row),
          workspaceId: row.workspace_id,
          activeCredentials: row.active_credentials,
          channelSlugs: row.channel_slugs,
        };
      });
    });
  }

  async #requireOwner(client: PoolClient, actorUserId: EntityId): Promise<EntityId> {
    const result = await client.query<WorkspaceIdRow>(
      `SELECT membership.workspace_id
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.user_id = $1
          AND membership.role = 'owner'
          AND membership.status = 'active'
          AND user_account.kind = 'human'
        ORDER BY membership.created_at, membership.workspace_id
        LIMIT 1`,
      [actorUserId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may manage bots");
    }
    const workspaceId = workspaceIdRowSchema.parse(row).workspace_id;
    const locked = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [
      workspaceId,
    ]);
    if (locked.rowCount !== 1) {
      throw new ApiError(403, "FORBIDDEN", "Only a workspace owner may manage bots");
    }
    return workspaceId;
  }

  async #requireBot(
    client: PoolClient,
    workspaceId: EntityId,
    username: string,
    lock: boolean,
  ): Promise<User> {
    const result = await client.query<BotUserRow>(
      `SELECT user_account.id,
              user_account.username,
              user_account.display_name,
              user_account.avatar_url,
              user_account.created_at,
              user_account.updated_at
         FROM users AS user_account
         JOIN workspace_memberships AS membership
           ON membership.user_id = user_account.id
          AND membership.workspace_id = $1
          AND membership.status = 'active'
        WHERE user_account.kind = 'bot'
          AND user_account.username = $2
        ${lock ? "FOR UPDATE OF user_account" : ""}`,
      [workspaceId, username],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Bot not found");
    return mapBot(row);
  }

  async #channels(
    client: PoolClient,
    workspaceId: EntityId,
    channelSlugs: readonly string[],
  ): Promise<readonly z.infer<typeof channelRowSchema>[]> {
    const result = await client.query<ChannelRow>(
      `SELECT id, slug, channel_mode
         FROM conversations
        WHERE workspace_id = $1
          AND kind = 'channel'
          AND slug = ANY($2::text[])
        ORDER BY slug`,
      [workspaceId, [...channelSlugs]],
    );
    const channels = result.rows.map((row) => channelRowSchema.parse(row));
    const found = new Set(channels.map((channel) => channel.slug));
    const missing = channelSlugs.find((slug) => !found.has(slug));
    if (missing !== undefined) {
      throw new ApiError(404, "NOT_FOUND", `Channel #${missing} was not found`);
    }
    if (channels.some((channel) => channel.channel_mode === "announcement")) {
      throw new ApiError(404, "NOT_FOUND", "Bots are not available in announcement channels");
    }
    return channels;
  }

  async #insertCredential(
    client: PoolClient,
    input: {
      readonly workspaceId: EntityId;
      readonly bot: User;
      readonly scopes: readonly BotScope[];
      readonly expiresAt: string;
      readonly actorUserId: EntityId;
    },
  ): Promise<IssuedBotCredential> {
    const issued = issueBotToken();
    const credentialId = entityIdSchema.parse(randomUUID());
    await client.query(
      `INSERT INTO bot_credentials
         (id, workspace_id, bot_user_id, token_hash, scopes, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        credentialId,
        input.workspaceId,
        input.bot.id,
        issued.hash,
        [...input.scopes],
        input.expiresAt,
        input.actorUserId,
        this.clock(),
      ],
    );
    return {
      bot: input.bot,
      credentialId,
      token: issued.token,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
    };
  }
}
