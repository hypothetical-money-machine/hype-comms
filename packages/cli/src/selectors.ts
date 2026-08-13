import {
  entityIdSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  workspaceBootstrapResponseSchema,
  type ConversationSummary,
  type User,
} from "@hype-comms/contracts";

import type { ApiClient } from "./client.js";
import { UsageError } from "./errors.js";

/**
 * Selector resolution is read-only and repeats within one command (several `--mention`s, or a
 * conversation lookup that also needs the member list). Each command builds its own `ApiClient`,
 * so keying the caches on the client scopes them to a single invocation.
 */
const conversationCache = new WeakMap<ApiClient, Promise<readonly ConversationSummary[]>>();
const memberCache = new WeakMap<ApiClient, Promise<readonly User[]>>();
const currentUserIdCache = new WeakMap<ApiClient, Promise<string>>();

async function fetchAllConversations(client: ApiClient): Promise<readonly ConversationSummary[]> {
  const conversations: ConversationSummary[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = await client.request({
      path: "/v1/conversations",
      query: { limit: 100, after },
      responseSchema: listConversationsResponseSchema,
    });
    conversations.push(...response.conversations);
    if (!response.hasMore) return conversations;
    if (response.nextCursor === null || seen.has(response.nextCursor)) {
      throw new UsageError("Conversation pagination did not advance", "PAGINATION_STALLED");
    }
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new UsageError("Conversation listing exceeded the supported page count", "TOO_MANY_PAGES");
}

export async function listAllConversations(
  client: ApiClient,
): Promise<readonly ConversationSummary[]> {
  const cached = conversationCache.get(client);
  if (cached !== undefined) return cached;
  const pending = fetchAllConversations(client);
  conversationCache.set(client, pending);
  return pending;
}

export async function listMembers(client: ApiClient): Promise<readonly User[]> {
  const cached = memberCache.get(client);
  if (cached !== undefined) return cached;
  const pending = client
    .request({ path: "/v1/members", responseSchema: listMembersResponseSchema })
    .then((response) => response.members);
  memberCache.set(client, pending);
  return pending;
}

async function currentUserId(client: ApiClient): Promise<string> {
  const cached = currentUserIdCache.get(client);
  if (cached !== undefined) return cached;
  const pending = client
    .request({ path: "/v1/bootstrap", responseSchema: workspaceBootstrapResponseSchema })
    .then((bootstrap) => bootstrap.currentUser.user.id);
  currentUserIdCache.set(client, pending);
  return pending;
}

export async function resolveMemberSelector(client: ApiClient, selector: string): Promise<string> {
  const id = entityIdSchema.safeParse(selector);
  if (id.success) return id.data;
  const username = selector.replace(/^@/u, "").toLocaleLowerCase("en-US");
  const matches = (await listMembers(client)).filter(
    (member) => member.username.toLocaleLowerCase("en-US") === username,
  );
  if (matches.length === 0)
    throw new UsageError(`No member matches ${selector}`, "MEMBER_NOT_FOUND");
  if (matches.length > 1)
    throw new UsageError(`Member selector ${selector} is ambiguous`, "AMBIGUOUS_MEMBER");
  return matches[0]!.id;
}

export async function resolveConversationSelector(
  client: ApiClient,
  selector: string,
): Promise<string> {
  const id = entityIdSchema.safeParse(selector);
  if (id.success) return id.data;
  const normalized = selector.replace(/^#/u, "").toLocaleLowerCase("en-US");
  const conversations = await listAllConversations(client);
  const channels = conversations.filter(
    ({ conversation }) =>
      conversation.kind === "channel" &&
      (conversation.slug?.toLocaleLowerCase("en-US") === normalized ||
        conversation.name?.toLocaleLowerCase("en-US") === normalized),
  );
  if (channels.length === 1) return channels[0]!.conversation.id;
  if (channels.length > 1) {
    throw new UsageError(
      `Conversation selector ${selector} is ambiguous`,
      "AMBIGUOUS_CONVERSATION",
    );
  }

  const members = await listMembers(client);
  const memberMatches = members.filter(
    (member) => member.username.toLocaleLowerCase("en-US") === normalized.replace(/^@/u, ""),
  );
  if (memberMatches.length === 1) {
    const selfId = await currentUserId(client);
    const memberId = memberMatches[0]!.id;
    const directMatches = conversations.filter(
      ({ conversation, participantIds }) =>
        conversation.kind === "direct_message" &&
        participantIds.includes(memberId) &&
        participantIds.includes(selfId),
    );
    if (directMatches.length === 1) return directMatches[0]!.conversation.id;
    if (directMatches.length > 1) {
      throw new UsageError(
        `Conversation selector ${selector} is ambiguous`,
        "AMBIGUOUS_CONVERSATION",
      );
    }
  }
  throw new UsageError(`No conversation matches ${selector}`, "CONVERSATION_NOT_FOUND");
}
