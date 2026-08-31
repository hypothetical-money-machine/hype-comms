import { randomBytes, randomUUID } from "node:crypto";

import {
  botAccessTokenSchema,
  botScopesSchema,
  channelWebhookSchema,
  channelSlugSchema,
  entityIdSchema,
  issuedChannelWebhookResponseSchema,
  isoDateTimeSchema,
  userSchema,
  type BotAccessToken,
  type BotScope,
  type ChannelWebhook,
  type EntityId,
  type IssuedChannelWebhookResponse,
  type User,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { withTransaction } from "../../db/pool.js";
import { ApiError } from "../../errors.js";
import { hashToken } from "../identity/tokens.js";

const MAX_ACTIVE_MEMBERS = 25;
const WEBHOOK_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

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
  readonly human_only: unknown;
}

interface ManageableChannelRow extends ChannelRow {
  readonly workspace_id: unknown;
  readonly name: unknown;
  readonly is_archived: unknown;
  readonly created_by: unknown;
  readonly actor_role: unknown;
}

interface ChannelWebhookRow extends BotUserRow {
  readonly conversation_id: unknown;
  readonly bot_user_id: unknown;
  readonly current_credential_id: unknown;
  readonly expires_at: unknown;
  readonly credential_active: unknown;
  readonly membership_status: unknown;
}

const workspaceIdRowSchema = z.object({ workspace_id: entityIdSchema }).strict();
const channelRowSchema = z
  .object({
    id: entityIdSchema,
    slug: channelSlugSchema,
    channel_mode: z.enum(["chat", "announcement"]),
    human_only: z.boolean(),
  })
  .strict();
const manageableChannelRowSchema = channelRowSchema
  .extend({
    workspace_id: entityIdSchema,
    name: z.string().trim().min(1).max(100),
    is_archived: z.boolean(),
    created_by: entityIdSchema.nullable(),
    actor_role: z.enum(["owner", "member"]),
  })
  .strict();
const channelWebhookRowSchema = z
  .object({
    conversation_id: entityIdSchema,
    bot_user_id: entityIdSchema,
    current_credential_id: entityIdSchema.nullable(),
    expires_at: z.date().nullable(),
    credential_active: z.boolean(),
    membership_status: z.enum(["invited", "active", "revoked"]),
    id: entityIdSchema,
    username: botUsernameSchema,
    display_name: botDisplayNameSchema,
    avatar_url: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
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

export interface AuthenticatedChannelWebhook {
  readonly identity: AuthenticatedBotIdentity;
  readonly conversationId: EntityId;
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
    private readonly publicApiUrl = "http://127.0.0.1:3000",
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

  /** Resolve a URL credential only while it is the active credential bound to one channel. */
  async authenticateChannelWebhook(token: string): Promise<AuthenticatedChannelWebhook | null> {
    const identity = await this.authenticate(token);
    if (identity === null || !identity.scopes.includes("messages:write")) return null;
    const result = await this.pool.query<{ conversation_id: unknown } & QueryResultRow>(
      `SELECT webhook.conversation_id
         FROM channel_webhooks AS webhook
         JOIN bot_credentials AS credential
           ON credential.id = webhook.current_credential_id
          AND credential.workspace_id = webhook.workspace_id
          AND credential.bot_user_id = webhook.bot_user_id
        WHERE webhook.current_credential_id = $1
          AND webhook.workspace_id = $2
          AND webhook.bot_user_id = $3
          AND webhook.disabled_at IS NULL
          AND credential.revoked_at IS NULL
          AND credential.expires_at > $4`,
      [
        identity.credentialId,
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        this.clock(),
      ],
    );
    const conversationId = entityIdSchema.safeParse(result.rows[0]?.conversation_id);
    return conversationId.success ? { identity, conversationId: conversationId.data } : null;
  }

  async getChannelWebhook(actorUserId: EntityId, channelId: EntityId): Promise<ChannelWebhook> {
    return withTransaction(this.pool, async (client) => {
      await this.#requireManageableWebhookChannel(client, actorUserId, channelId, false);
      const row = await this.#channelWebhook(client, channelId, false);
      if (row === null) throw new ApiError(404, "NOT_FOUND", "Channel webhook not found");
      return this.#mapChannelWebhook(row);
    });
  }

  async enableChannelWebhook(
    actorUserId: EntityId,
    channelId: EntityId,
  ): Promise<IssuedChannelWebhookResponse> {
    const now = this.clock();
    try {
      return await withTransaction(this.pool, async (client) => {
        const channel = await this.#requireManageableWebhookChannel(
          client,
          actorUserId,
          channelId,
          true,
        );
        const existing = await this.#channelWebhook(client, channelId, true);
        if (existing?.credential_active) {
          throw new ApiError(409, "CONFLICT", "The channel webhook is already enabled");
        }

        let bot: User;
        if (existing === null) {
          await this.#requireMemberCapacity(client, channel.workspace_id);
          const botId = entityIdSchema.parse(randomUUID());
          const username = botUsernameSchema.parse(`webhook-${channel.id.replaceAll("-", "")}`);
          const displayName = botDisplayNameSchema.parse(
            `${channel.name.slice(0, 72).trimEnd()} Webhook`,
          );
          const inserted = await client.query<BotUserRow>(
            `INSERT INTO users (id, email, kind, username, display_name, avatar_url)
             VALUES ($1, NULL, 'bot', $2, $3, NULL)
             RETURNING id, username, display_name, avatar_url, created_at, updated_at`,
            [botId, username, displayName],
          );
          const botRow = inserted.rows[0];
          if (botRow === undefined) throw new Error("Webhook bot insert returned no row");
          bot = mapBot(botRow);
          await client.query(
            `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
             VALUES ($1, $2, 'member', 'active')`,
            [channel.workspace_id, bot.id],
          );
          await client.query(
            `INSERT INTO bot_channel_grants
               (workspace_id, bot_user_id, conversation_id, granted_by)
             VALUES ($1, $2, $3, $4)`,
            [channel.workspace_id, bot.id, channel.id, actorUserId],
          );
        } else {
          bot = mapBot(existing);
          if (existing.membership_status !== "active") {
            await this.#requireMemberCapacity(client, channel.workspace_id);
            await client.query(
              `UPDATE workspace_memberships
                  SET status = 'active', updated_at = $3
                WHERE workspace_id = $1 AND user_id = $2`,
              [channel.workspace_id, bot.id, now],
            );
          }
        }

        await this.#revokeBotCredentials(client, channel.workspace_id, bot.id, now);
        const issued = await this.#insertCredential(client, {
          workspaceId: channel.workspace_id,
          bot,
          scopes: ["messages:write"],
          expiresAt: new Date(now.getTime() + WEBHOOK_CREDENTIAL_TTL_MS).toISOString(),
          actorUserId,
        });
        if (existing === null) {
          await client.query(
            `INSERT INTO channel_webhooks
               (conversation_id, workspace_id, bot_user_id, current_credential_id,
                created_by, updated_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5, $6, $6)`,
            [channel.id, channel.workspace_id, bot.id, issued.credentialId, actorUserId, now],
          );
        } else {
          await client.query(
            `UPDATE channel_webhooks
                SET current_credential_id = $2,
                    updated_by = $3,
                    updated_at = $4,
                    disabled_at = NULL
              WHERE conversation_id = $1`,
            [channel.id, issued.credentialId, actorUserId, now],
          );
        }
        return this.#issuedChannelWebhook(channel.id, issued);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "CONFLICT", "The channel webhook could not be provisioned");
      }
      throw error;
    }
  }

  async rotateChannelWebhook(
    actorUserId: EntityId,
    channelId: EntityId,
  ): Promise<IssuedChannelWebhookResponse> {
    const now = this.clock();
    return withTransaction(this.pool, async (client) => {
      const channel = await this.#requireManageableWebhookChannel(
        client,
        actorUserId,
        channelId,
        true,
      );
      const existing = await this.#channelWebhook(client, channelId, true);
      if (existing === null) throw new ApiError(404, "NOT_FOUND", "Channel webhook not found");
      if (!existing.credential_active) {
        throw new ApiError(409, "CONFLICT", "Enable the channel webhook before rotating it");
      }
      const bot = mapBot(existing);
      await this.#revokeBotCredentials(client, channel.workspace_id, bot.id, now);
      const issued = await this.#insertCredential(client, {
        workspaceId: channel.workspace_id,
        bot,
        scopes: ["messages:write"],
        expiresAt: new Date(now.getTime() + WEBHOOK_CREDENTIAL_TTL_MS).toISOString(),
        actorUserId,
      });
      await client.query(
        `UPDATE channel_webhooks
            SET current_credential_id = $2,
                updated_by = $3,
                updated_at = $4,
                disabled_at = NULL
          WHERE conversation_id = $1`,
        [channel.id, issued.credentialId, actorUserId, now],
      );
      return this.#issuedChannelWebhook(channel.id, issued);
    });
  }

  async disableChannelWebhook(actorUserId: EntityId, channelId: EntityId): Promise<ChannelWebhook> {
    const now = this.clock();
    return withTransaction(this.pool, async (client) => {
      const channel = await this.#requireManageableWebhookChannel(
        client,
        actorUserId,
        channelId,
        false,
        true,
      );
      const existing = await this.#channelWebhook(client, channelId, true);
      if (existing === null) throw new ApiError(404, "NOT_FOUND", "Channel webhook not found");
      await this.#revokeBotCredentials(client, channel.workspace_id, existing.bot_user_id, now);
      await client.query(
        `UPDATE workspace_memberships
            SET status = 'revoked', updated_at = $3
          WHERE workspace_id = $1 AND user_id = $2`,
        [channel.workspace_id, existing.bot_user_id, now],
      );
      await client.query(
        `UPDATE channel_webhooks
            SET current_credential_id = NULL,
                updated_by = $2,
                updated_at = $3,
                disabled_at = coalesce(disabled_at, $3)
          WHERE conversation_id = $1`,
        [channel.id, actorUserId, now],
      );
      const disabled = await this.#channelWebhook(client, channelId, false);
      if (disabled === null) throw new Error("Disabled channel webhook disappeared");
      return this.#mapChannelWebhook(disabled);
    });
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
        await this.#requireMemberCapacity(client, workspaceId, false);
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

  async #requireManageableWebhookChannel(
    client: PoolClient,
    actorUserId: EntityId,
    channelId: EntityId,
    requireWritable: boolean,
    lock = requireWritable,
  ): Promise<z.infer<typeof manageableChannelRowSchema>> {
    const result = await client.query<ManageableChannelRow>(
      `SELECT conversation.id,
              conversation.workspace_id,
              conversation.name,
              conversation.slug,
              conversation.channel_mode,
              conversation.human_only,
              conversation.is_archived,
              conversation.created_by,
              actor_membership.role AS actor_role
         FROM conversations AS conversation
         JOIN workspace_memberships AS actor_membership
           ON actor_membership.workspace_id = conversation.workspace_id
          AND actor_membership.user_id = $1
          AND actor_membership.status = 'active'
         JOIN users AS actor
           ON actor.id = actor_membership.user_id
          AND actor.kind = 'human'
        WHERE conversation.id = $2
          AND conversation.kind = 'channel'
        ${lock ? "FOR UPDATE OF conversation" : ""}`,
      [actorUserId, channelId],
    );
    const raw = result.rows[0];
    if (raw === undefined) throw new ApiError(404, "NOT_FOUND", "Channel not found");
    const channel = manageableChannelRowSchema.parse(raw);
    if (channel.actor_role !== "owner" && channel.created_by !== actorUserId) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Only the channel creator or a workspace owner may manage its webhook",
      );
    }
    if (requireWritable && channel.is_archived) {
      throw new ApiError(404, "NOT_FOUND", "Channel not found");
    }
    if (channel.channel_mode === "announcement") {
      throw new ApiError(404, "NOT_FOUND", "Webhooks are not available in announcement channels");
    }
    if (channel.human_only) {
      throw new ApiError(404, "NOT_FOUND", "Webhooks are not available in humans-only channels");
    }
    return channel;
  }

  async #channelWebhook(
    client: PoolClient,
    channelId: EntityId,
    lock: boolean,
  ): Promise<z.infer<typeof channelWebhookRowSchema> | null> {
    const result = await client.query<ChannelWebhookRow>(
      `SELECT webhook.conversation_id,
              webhook.bot_user_id,
              webhook.current_credential_id,
              credential.expires_at,
              membership.status AS membership_status,
              (
                webhook.current_credential_id IS NOT NULL
                AND webhook.disabled_at IS NULL
                AND membership.status = 'active'
                AND credential.revoked_at IS NULL
                AND credential.expires_at > $2
                AND 'messages:write' = ANY(credential.scopes)
              ) AS credential_active,
              bot.id,
              bot.username,
              bot.display_name,
              bot.avatar_url,
              bot.created_at,
              bot.updated_at
         FROM channel_webhooks AS webhook
         JOIN users AS bot
           ON bot.id = webhook.bot_user_id
          AND bot.kind = 'bot'
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = webhook.workspace_id
          AND membership.user_id = webhook.bot_user_id
         LEFT JOIN bot_credentials AS credential
           ON credential.id = webhook.current_credential_id
          AND credential.workspace_id = webhook.workspace_id
          AND credential.bot_user_id = webhook.bot_user_id
        WHERE webhook.conversation_id = $1
        ${lock ? "FOR UPDATE OF webhook" : ""}`,
      [channelId, this.clock()],
    );
    const row = result.rows[0];
    return row === undefined ? null : channelWebhookRowSchema.parse(row);
  }

  #mapChannelWebhook(row: z.infer<typeof channelWebhookRowSchema>): ChannelWebhook {
    return channelWebhookSchema.parse({
      channelId: row.conversation_id,
      enabled: row.credential_active,
      bot: mapBot(row),
      expiresAt: row.expires_at?.toISOString() ?? null,
    });
  }

  #issuedChannelWebhook(
    channelId: EntityId,
    issued: IssuedBotCredential,
  ): IssuedChannelWebhookResponse {
    const webhookUrl = new URL(`/v1/webhooks/incoming/${issued.token}`, this.publicApiUrl);
    return issuedChannelWebhookResponseSchema.parse({
      webhook: {
        channelId,
        enabled: true,
        bot: issued.bot,
        expiresAt: issued.expiresAt,
      },
      webhookUrl: webhookUrl.toString(),
    });
  }

  async #requireMemberCapacity(
    client: PoolClient,
    workspaceId: EntityId,
    lockWorkspace = true,
  ): Promise<void> {
    if (lockWorkspace) {
      const locked = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [
        workspaceId,
      ]);
      if (locked.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
    }
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
  }

  async #revokeBotCredentials(
    client: PoolClient,
    workspaceId: EntityId,
    botUserId: EntityId,
    revokedAt: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE bot_credentials
          SET revoked_at = $3
        WHERE workspace_id = $1
          AND bot_user_id = $2
          AND revoked_at IS NULL`,
      [workspaceId, botUserId, revokedAt],
    );
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
      `SELECT id, slug, channel_mode, human_only
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
    if (channels.some((channel) => channel.human_only)) {
      throw new ApiError(404, "NOT_FOUND", "Bots are not available in humans-only channels");
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
