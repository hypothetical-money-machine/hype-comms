import { randomUUID } from "node:crypto";

import {
  ATTACHMENTS_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  advanceReadCursorRequestSchema,
  advanceReadCursorResponseSchema,
  archiveChannelRequestSchema,
  channelSlugFromName,
  clientMessageIdSchema,
  conversationMutationResponseSchema,
  createChannelRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  groupDirectConversationRequestSchema,
  idempotencyKeySchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  listPublicChannelsResponseSchema,
  messageHistoryResponseSchema,
  paginationCursorSchema,
  sendConversationMessageRequestSchema,
  sendMessageResponseSchema,
  sequenceSchema,
  syncResponseSchema,
  workspaceBootstrapResponseSchema,
} from "@hype-comms/contracts";

import {
  booleanOption,
  integerOption,
  multipleOption,
  parseCommandArguments,
  requirePositionals,
  stringOption,
} from "../argv.js";
import { clientFromContext } from "../context.js";
import { UsageError } from "../errors.js";
import { messageBody } from "../input.js";
import { writeResult } from "../output.js";
import {
  listAllConversations,
  resolveConversationSelector,
  resolveDirectMemberSelector,
  resolveMemberSelector,
  resolvePublicChannelSelector,
} from "../selectors.js";
import type { CommandContext } from "../types.js";

const GROUP_DIRECT_MESSAGES_HEADER = {
  "x-hype-comms-capabilities": GROUP_DIRECT_MESSAGES_CAPABILITY,
} as const;

export async function workspaceCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  requirePositionals(parseCommandArguments(args, {}), 0);
  const client = await clientFromContext(context);
  if (subcommand === "bootstrap") {
    writeResult(
      context.runtime.io,
      await client.request({
        path: "/v1/bootstrap",
        responseSchema: workspaceBootstrapResponseSchema,
        headers: GROUP_DIRECT_MESSAGES_HEADER,
      }),
      context.options.json,
    );
    return;
  }
  if (subcommand === "members") {
    writeResult(
      context.runtime.io,
      await client.request({ path: "/v1/members", responseSchema: listMembersResponseSchema }),
      context.options.json,
    );
    return;
  }
  throw new UsageError("Usage: hype-comms-cli workspace <bootstrap|members>");
}

export async function conversationsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand !== "list") {
    throw new UsageError(
      "Usage: hype-comms-cli conversations list [--after CURSOR] [--limit N] [--all]",
    );
  }
  const parsed = parseCommandArguments(args, {
    after: { kind: "string" },
    limit: { kind: "string" },
    all: { kind: "boolean" },
  });
  requirePositionals(parsed, 0);
  const client = await clientFromContext(context);
  if (booleanOption(parsed, "all")) {
    if (
      stringOption(parsed, "after") !== undefined ||
      stringOption(parsed, "limit") !== undefined
    ) {
      throw new UsageError("--all cannot be combined with --after or --limit");
    }
    const conversations = await listAllConversations(client);
    writeResult(
      context.runtime.io,
      { conversations, nextCursor: null, hasMore: false },
      context.options.json,
    );
    return;
  }
  const afterValue = stringOption(parsed, "after");
  const parsedAfter =
    afterValue === undefined ? undefined : paginationCursorSchema.safeParse(afterValue);
  if (parsedAfter !== undefined && !parsedAfter.success) {
    throw new UsageError("--after is not a valid pagination cursor", "INVALID_CURSOR");
  }
  const after = parsedAfter?.data;
  const response = await client.request({
    path: "/v1/conversations",
    query: { after, limit: integerOption(parsed, "limit", 50, 100) },
    responseSchema: listConversationsResponseSchema,
    headers: GROUP_DIRECT_MESSAGES_HEADER,
  });
  writeResult(context.runtime.io, response, context.options.json);
}

export async function channelsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "list") {
    const parsed = parseCommandArguments(args, {
      after: { kind: "string" },
      limit: { kind: "string" },
    });
    requirePositionals(parsed, 0);
    const afterValue = stringOption(parsed, "after");
    const parsedAfter =
      afterValue === undefined ? undefined : paginationCursorSchema.safeParse(afterValue);
    if (parsedAfter !== undefined && !parsedAfter.success) {
      throw new UsageError("--after is not a valid pagination cursor", "INVALID_CURSOR");
    }
    const response = await client.request({
      path: "/v1/channels",
      query: {
        after: parsedAfter?.data,
        limit: integerOption(parsed, "limit", 50, 100),
      },
      responseSchema: listPublicChannelsResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "create") {
    const parsed = parseCommandArguments(args, {
      slug: { kind: "string" },
      topic: { kind: "string" },
    });
    const [name] = requirePositionals(parsed, 1);
    const body = {
      name: name!,
      slug: stringOption(parsed, "slug") ?? channelSlugFromName(name!),
      topic: stringOption(parsed, "topic") ?? null,
    };
    const response = await client.request({
      method: "POST",
      path: "/v1/channels",
      body,
      requestSchema: createChannelRequestSchema,
      responseSchema: conversationMutationResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "archive") {
    const parsed = parseCommandArguments(args, {});
    const [selector] = requirePositionals(parsed, 1);
    const id = await resolveConversationSelector(client, selector!);
    const body = { isArchived: true } as const;
    const response = await client.request({
      method: "PATCH",
      path: `/v1/channels/${id}`,
      body,
      requestSchema: archiveChannelRequestSchema,
      responseSchema: conversationMutationResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "join") {
    const parsed = parseCommandArguments(args, {});
    const [selector] = requirePositionals(parsed, 1);
    const id = await resolvePublicChannelSelector(client, selector!);
    const response = await client.request({
      method: "PUT",
      path: `/v1/channels/${id}/membership`,
      responseSchema: conversationMutationResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  throw new UsageError("Usage: hype-comms-cli channels <list|create|archive|join>");
}

export async function dmsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "create") {
    const parsed = parseCommandArguments(args, {});
    const [member] = requirePositionals(parsed, 1);
    const body = { memberId: await resolveDirectMemberSelector(client, member!) };
    const response = await client.request({
      method: "POST",
      path: "/v1/direct-conversations",
      body,
      requestSchema: directConversationRequestSchema,
      responseSchema: conversationMutationResponseSchema,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  if (subcommand === "create-group") {
    const parsed = parseCommandArguments(args, {
      "idempotency-key": { kind: "string" },
    });
    const members = parsed.positionals;
    if (members.length < 2 || members.length > 24) {
      throw new UsageError(
        "A group direct conversation requires between 2 and 24 members",
        "INVALID_GROUP_SIZE",
      );
    }
    const key = idempotencyKeySchema.safeParse(
      stringOption(parsed, "idempotency-key") ?? randomUUID(),
    );
    if (!key.success) {
      throw new UsageError("--idempotency-key is invalid", "INVALID_IDEMPOTENCY_KEY");
    }
    const memberIds = await Promise.all(
      members.map((member) => resolveDirectMemberSelector(client, member)),
    );
    if (new Set(memberIds).size !== memberIds.length) {
      throw new UsageError("Group members must be unique", "DUPLICATE_MEMBER");
    }
    const body = { memberIds };
    const response = await client.request({
      method: "POST",
      path: "/v1/group-direct-conversations",
      body,
      requestSchema: groupDirectConversationRequestSchema,
      responseSchema: conversationMutationResponseSchema,
      headers: {
        "idempotency-key": key.data,
        "x-hype-comms-capabilities": GROUP_DIRECT_MESSAGES_CAPABILITY,
      },
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  throw new UsageError(
    "Usage: hype-comms-cli dms <create MEMBER|create-group MEMBER MEMBER [MEMBER...]>",
  );
}

export async function messagesCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "history") {
    const parsed = parseCommandArguments(args, {
      before: { kind: "string" },
      limit: { kind: "string" },
    });
    const [selector] = requirePositionals(parsed, 1);
    const id = await resolveConversationSelector(client, selector!);
    const beforeValue = stringOption(parsed, "before");
    const parsedBefore =
      beforeValue === undefined ? undefined : paginationCursorSchema.safeParse(beforeValue);
    if (parsedBefore !== undefined && !parsedBefore.success) {
      throw new UsageError("--before is not a valid pagination cursor", "INVALID_CURSOR");
    }
    const before = parsedBefore?.data;
    const response = await client.request({
      path: `/v1/conversations/${id}/messages`,
      query: { before, limit: integerOption(parsed, "limit", 50, 100) },
      responseSchema: messageHistoryResponseSchema,
      headers: { "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY },
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }

  if (subcommand === "send") {
    const parsed = parseCommandArguments(args, {
      file: { kind: "string" },
      mention: { kind: "string", multiple: true },
      "client-message-id": { kind: "string" },
      "thread-root-id": { kind: "string" },
    });
    const [selector, inline] = requirePositionals(parsed, 1, 2);
    const conversationId = await resolveConversationSelector(client, selector!);
    const clientMessageValue = stringOption(parsed, "client-message-id") ?? randomUUID();
    const clientMessageId = clientMessageIdSchema.safeParse(clientMessageValue);
    if (!clientMessageId.success) {
      throw new UsageError("--client-message-id must be a UUID", "INVALID_CLIENT_MESSAGE_ID");
    }
    const threadRootValue = stringOption(parsed, "thread-root-id");
    const threadRootId =
      threadRootValue === undefined ? null : entityIdSchema.safeParse(threadRootValue);
    if (threadRootId !== null && !threadRootId.success) {
      throw new UsageError("--thread-root-id must be a UUID", "INVALID_THREAD_ROOT_ID");
    }
    const mentionedUserIds = await Promise.all(
      multipleOption(parsed, "mention").map((selectorValue) =>
        resolveMemberSelector(client, selectorValue),
      ),
    );
    const body = {
      threadRootId: threadRootId === null ? null : threadRootId.data,
      body: await messageBody({
        io: context.runtime.io,
        ...(inline === undefined ? {} : { inline }),
        ...(stringOption(parsed, "file") === undefined
          ? {}
          : { file: stringOption(parsed, "file")! }),
      }),
      bodyFormat: "hype_comms_markdown_v1" as const,
      clientMessageId: clientMessageId.data,
      mentionedUserIds: [...new Set(mentionedUserIds)],
      attachmentIds: [],
    };
    const response = await client.request({
      method: "POST",
      path: `/v1/conversations/${conversationId}/messages`,
      body,
      requestSchema: sendConversationMessageRequestSchema,
      responseSchema: sendMessageResponseSchema,
      headers: {
        "idempotency-key": clientMessageId.data,
        "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
      },
      clientMessageId: clientMessageId.data,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }
  throw new UsageError("Usage: hype-comms-cli messages <history|send>");
}

export async function readCursorsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand !== "advance") {
    throw new UsageError("Usage: hype-comms-cli read-cursors advance <conversation> <message-id>");
  }
  const parsed = parseCommandArguments(args, {});
  const [conversation, message] = requirePositionals(parsed, 2);
  const messageId = entityIdSchema.safeParse(message);
  if (!messageId.success)
    throw new UsageError("The message ID must be a UUID", "INVALID_MESSAGE_ID");
  const client = await clientFromContext(context);
  const conversationId = await resolveConversationSelector(client, conversation!);
  const body = { lastReadMessageId: messageId.data };
  const response = await client.request({
    method: "PUT",
    path: `/v1/conversations/${conversationId}/read-cursor`,
    body,
    requestSchema: advanceReadCursorRequestSchema,
    responseSchema: advanceReadCursorResponseSchema,
  });
  writeResult(context.runtime.io, response, context.options.json);
}

export async function syncCommand(context: CommandContext, args: readonly string[]): Promise<void> {
  const parsed = parseCommandArguments(args, {
    after: { kind: "string" },
    limit: { kind: "string" },
  });
  requirePositionals(parsed, 0);
  const afterValue = stringOption(parsed, "after");
  if (afterValue === undefined || !sequenceSchema.safeParse(afterValue).success) {
    throw new UsageError("sync requires --after with a decimal cursor", "INVALID_CURSOR");
  }
  const response = await (
    await clientFromContext(context)
  ).request({
    path: "/v1/sync",
    query: { after: afterValue, limit: integerOption(parsed, "limit", 100, 100) },
    responseSchema: syncResponseSchema,
  });
  writeResult(context.runtime.io, response, context.options.json);
}
