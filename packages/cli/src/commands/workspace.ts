import { randomUUID } from "node:crypto";

import {
  AGENT_CONTEXT_PACK_CAPABILITY,
  AGENT_CONTEXT_PACK_DEFAULT_LIMIT,
  AGENT_CONTEXT_PACK_MAX_LIMIT,
  advanceReadCursorRequestSchema,
  advanceReadCursorResponseSchema,
  agentContextHistoryQuerySchema,
  agentContextHistoryResponseSchema,
  archiveChannelRequestSchema,
  channelSlugFromName,
  clientMessageIdSchema,
  conversationMutationResponseSchema,
  createChannelRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
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
  resolveMemberSelector,
} from "../selectors.js";
import type { CommandContext } from "../types.js";

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
  });
  writeResult(context.runtime.io, response, context.options.json);
}

export async function channelsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
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
  throw new UsageError("Usage: hype-comms-cli channels <create|archive>");
}

export async function dmsCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand !== "create") throw new UsageError("Usage: hype-comms-cli dms create <member>");
  const parsed = parseCommandArguments(args, {});
  const [member] = requirePositionals(parsed, 1);
  const client = await clientFromContext(context);
  const body = { memberId: await resolveMemberSelector(client, member!) };
  const response = await client.request({
    method: "POST",
    path: "/v1/direct-conversations",
    body,
    requestSchema: directConversationRequestSchema,
    responseSchema: conversationMutationResponseSchema,
  });
  writeResult(context.runtime.io, response, context.options.json);
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
      "context-pack": { kind: "boolean" },
      limit: { kind: "string" },
      "through-message-id": { kind: "string" },
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
    const contextPack = booleanOption(parsed, "context-pack");
    const throughMessageValue = stringOption(parsed, "through-message-id");
    if (!contextPack && throughMessageValue !== undefined) {
      throw new UsageError("--through-message-id requires --context-pack");
    }
    if (before !== undefined && throughMessageValue !== undefined) {
      throw new UsageError("--before cannot be combined with --through-message-id");
    }
    const throughMessageId =
      throughMessageValue === undefined ? undefined : entityIdSchema.safeParse(throughMessageValue);
    if (throughMessageId !== undefined && !throughMessageId.success) {
      throw new UsageError("--through-message-id must be a UUID", "INVALID_MESSAGE_ID");
    }
    if (contextPack) {
      const query = agentContextHistoryQuerySchema.safeParse({
        contextPack: true,
        throughMessageId: throughMessageId?.data,
        before,
        limit: integerOption(
          parsed,
          "limit",
          AGENT_CONTEXT_PACK_DEFAULT_LIMIT,
          AGENT_CONTEXT_PACK_MAX_LIMIT,
        ),
      });
      if (!query.success) {
        throw new UsageError("The context-pack history options are invalid");
      }
      const response = await client.request({
        path: `/v1/conversations/${id}/messages`,
        query: query.data,
        responseSchema: agentContextHistoryResponseSchema,
        headers: { "x-hype-comms-capabilities": AGENT_CONTEXT_PACK_CAPABILITY },
      });
      writeResult(context.runtime.io, response, context.options.json);
      return;
    }

    const response = await client.request({
      path: `/v1/conversations/${id}/messages`,
      query: { before, limit: integerOption(parsed, "limit", 50, 100) },
      responseSchema: messageHistoryResponseSchema,
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
      headers: { "idempotency-key": clientMessageId.data },
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
