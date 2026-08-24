import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  AGENT_CONTEXT_PACK_CAPABILITY,
  AGENT_CONTEXT_PACK_DEFAULT_LIMIT,
  AGENT_CONTEXT_PACK_MAX_BYTES,
  AGENT_CONTEXT_PACK_MAX_LIMIT,
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  ATTACHMENTS_CAPABILITY,
  DEFAULT_AGENT_AGENCY_PROFILE,
  DEFAULT_AGENCY_AGENT_SCOPES,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
  MESSAGE_RETRACT_WINDOW_MS,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  apiErrorEnvelopeSchema,
  agentContextHistoryQuerySchema,
  agentContextHistoryResponseSchema,
  agentTokenMetadataSchema,
  agentTokenSecretSchema,
  agentEnrollmentCredentialVerifierSchema,
  agentEnrollmentSchema,
  agentUserSchema,
  botAccessTokenSchema,
  botScopesSchema,
  channelSlugFromName,
  channelSlugSchema,
  clientCapabilitiesHeaderSchema,
  conversationSummarySchema,
  conversationSchema,
  createAgentTokenRequestSchema,
  requestAgentEnrollmentSchema,
  currentAgentPrincipalSchema,
  currentPrincipalSchema,
  createChannelOperationSchema,
  createFileUploadRequestSchema,
  createTaskOperationSchema,
  currentUserSchema,
  displayNameSchema,
  entityVersionSchema,
  chatSessionStateSchema,
  injectionSafeCompactJsonByteLength,
  listConversationsQuerySchema,
  listConversationsResponseSchema,
  listMessageReactionsRequestSchema,
  memberUpdatedEventSchema,
  messageReactionTargetSchema,
  messageHistoryResponseSchema,
  messageSchema,
  messageHistoryQuerySchema,
  messageThreadResponseSchema,
  messageThreadRequestSchema,
  messageSearchQuerySchema,
  moveTaskOperationSchema,
  reactionEmojiSchema,
  reactionSchema,
  retractMessageResponseSchema,
  sendMessageOperationSchema,
  sendMessageRequestSchema,
  syncAttemptResultSchema,
  syncQuerySchema,
  systemConnectedEventSchema,
  taskListQuerySchema,
  taskNumberSchema,
  taskRecordSchema,
  taskSchema,
  themeAccentColorSchema,
  themeDesignSchema,
  themePreferenceSchema,
  themeStateSchema,
  updateStateSchema,
  updateTaskOperationSchema,
  updateVersionSchema,
  userSchema,
  workspaceEventSchema,
  workspaceBootstrapResponseSchema,
  workspaceSnapshotSchema,
} from "../src/index.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const REACTION_ID = "10000000-0000-4000-8000-000000000005";
const TASK_ID = "10000000-0000-4000-8000-000000000006";
const REPLY_ID = "10000000-0000-4000-8000-000000000007";
const NOW = "2026-07-21T12:00:00.000Z";

const CONVERSATION_SUMMARY = {
  conversation: {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    kind: "channel",
    name: "General",
    slug: "general",
    topic: null,
    access: "workspace",
    isArchived: false,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  participantIds: [],
  membershipRole: null,
  lastMessage: null,
  unreadCount: 0,
  mentionCount: 0,
  readCursor: null,
};

const BOOTSTRAP = {
  currentUser: {
    user: {
      id: USER_ID,
      username: "morgan",
      displayName: "Morgan",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    email: "morgan@example.com",
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "HMM",
    slug: "hmm",
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [],
  conversations: [CONVERSATION_SUMMARY],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "12",
  featureFlags: { channels: true, directMessages: true, mentions: true },
};

const TASK = {
  id: TASK_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  number: "7",
  version: 1,
  title: "Ship the Kanban board",
  description: "Keep the renderer unprivileged.",
  status: "in_progress",
  priority: "high",
  assigneeId: USER_ID,
  dueOn: "2026-08-15",
  sourceMessageId: MESSAGE_ID,
  rank: "2048",
  createdBy: USER_ID,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

describe("desktop theme contracts", () => {
  it.each(["system", "light", "dark", "dim"] as const)(
    "accepts the %s preference",
    (preference) => {
      expect(themePreferenceSchema.parse(preference)).toBe(preference);
    },
  );

  it("accepts a strict bounded design and canonicalizes its accent", () => {
    expect(
      themeDesignSchema.parse({
        preference: "system",
        accentColor: "#A15EFF",
      }),
    ).toEqual({ preference: "system", accentColor: "#a15eff" });
    expect(themeDesignSchema.parse({ preference: "dark", accentColor: null })).toEqual({
      preference: "dark",
      accentColor: null,
    });
    expect(themeAccentColorSchema.parse("#123ABC")).toBe("#123abc");

    for (const value of ["#fff", "123456", "#12345678", "red", "url(file:///tmp/x)"]) {
      expect(themeAccentColorSchema.safeParse(value).success).toBe(false);
    }
    expect(
      themeDesignSchema.safeParse({ preference: "light", accentColor: "#123456", css: "body {}" })
        .success,
    ).toBe(false);
  });

  it("accepts strict canonical system, built-in, and named theme state", () => {
    expect(
      themeStateSchema.parse({
        preference: "system",
        resolvedThemeId: "dark",
        resolvedColorScheme: "dark",
      }),
    ).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    expect(
      themeStateSchema.parse({
        preference: "light",
        resolvedThemeId: "light",
        resolvedColorScheme: "light",
        accentColor: "#A15EFF",
      }),
    ).toEqual({
      preference: "light",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: "#a15eff",
    });
    expect(
      themeStateSchema.parse({
        preference: "dim",
        resolvedThemeId: "dim",
        resolvedColorScheme: "dark",
      }),
    ).toEqual({
      preference: "dim",
      resolvedThemeId: "dim",
      resolvedColorScheme: "dark",
    });
  });

  it.each([
    { preference: "Dim Theme", resolvedThemeId: "dim", resolvedColorScheme: "dark" },
    { preference: "system", resolvedThemeId: "system", resolvedColorScheme: "dark" },
    { preference: "system", resolvedThemeId: "dark", resolvedColorScheme: "sepia" },
    { preference: "dark", resolvedThemeId: "light", resolvedColorScheme: "dark" },
    { preference: "dim", resolvedThemeId: "dark", resolvedColorScheme: "dark" },
    {
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: "rebeccapurple",
    },
    {
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      css: "body {}",
    },
  ])("rejects an invalid or expanded theme wire value", (value) => {
    expect(themeStateSchema.safeParse(value).success).toBe(false);
  });
});

describe("entity contracts", () => {
  it("accepts representative entity payloads", () => {
    expect(
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ id: USER_ID, kind: "human", title: null });

    expect(
      userSchema.parse({
        id: USER_ID,
        kind: "bot",
        username: "release-bot",
        displayName: "Release Bot",
        avatarUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ kind: "bot" });

    expect(
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        title: "  Chief Mischief Officer  ",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ title: "Chief Mischief Officer" });
    expect(() =>
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        title: "line\u0000break",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();

    expect(
      conversationSchema.parse({
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "general",
        slug: "general",
        topic: null,
        access: "workspace",
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ kind: "channel", channelMode: "chat" });

    expect(
      conversationSchema.parse({
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "announcements",
        slug: "announcements",
        topic: null,
        access: "workspace",
        channelMode: "announcement",
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ kind: "channel", channelMode: "announcement" });

    expect(() =>
      conversationSchema.parse({
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "direct_message",
        name: null,
        slug: null,
        topic: null,
        access: null,
        channelMode: "announcement",
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();

    expect(
      messageSchema.parse({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "42",
        version: 1,
        clientMessageId: MESSAGE_ID,
        authorId: USER_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hype_comms_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ body: "Hello" });
    expect(MESSAGE_RETRACT_WINDOW_MS).toBe(5 * 60 * 1_000);
    const retracted = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      conversationSequence: "42",
      version: 2,
      clientMessageId: MESSAGE_ID,
      authorId: USER_ID,
      threadRootId: null,
      body: "still stored",
      bodyFormat: "hype_comms_markdown_v1" as const,
      editedAt: null,
      deletedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(messageSchema.parse(retracted)).toMatchObject({
      body: "still stored",
      deletedAt: NOW,
    });
    expect(
      retractMessageResponseSchema.parse({ message: retracted, syncCursor: "44" }),
    ).toMatchObject({ message: { deletedAt: NOW, body: "still stored" }, syncCursor: "44" });
    expect(() =>
      retractMessageResponseSchema.parse({
        message: { ...retracted, deletedAt: null },
        syncCursor: "44",
      }),
    ).toThrow();
  });

  it("rejects unknown fields so wire-shape changes are deliberate", () => {
    expect(() =>
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
        role: "admin",
      }),
    ).toThrow();
  });

  it("accepts one normalized Unicode emoji and rejects text or multiple emoji", () => {
    expect(reactionEmojiSchema.parse("👩🏽‍💻")).toBe("👩🏽‍💻");
    expect(reactionEmojiSchema.parse("🇺🇸")).toBe("🇺🇸");
    expect(reactionEmojiSchema.parse("1️⃣")).toBe("1️⃣");
    expect(() => reactionEmojiSchema.parse("shipit")).toThrow();
    expect(() => reactionEmojiSchema.parse("👍 🎉")).toThrow();
    expect(() => reactionEmojiSchema.parse(" 👍 ")).toThrow();

    expect(
      reactionSchema.parse({
        id: REACTION_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        emoji: "❤️",
        createdAt: NOW,
      }),
    ).toMatchObject({ emoji: "❤️" });
  });

  it("accepts only prefixed 256-bit bot tokens and unique task scopes", () => {
    expect(botAccessTokenSchema.parse(`hype_comms_bot_${"a".repeat(43)}`)).toHaveLength(58);
    expect(() => botAccessTokenSchema.parse("a".repeat(43))).toThrow();
    expect(botScopesSchema.parse(["tasks:read", "tasks:write"])).toEqual([
      "tasks:read",
      "tasks:write",
    ]);
    expect(() => botScopesSchema.parse(["tasks:read", "tasks:read"])).toThrow();
  });

  it("keeps bot principals out of the human desktop-session contract", () => {
    expect(() =>
      currentUserSchema.parse({
        ...BOOTSTRAP.currentUser,
        user: { ...BOOTSTRAP.currentUser.user, kind: "bot" },
      }),
    ).toThrow();
  });

  it("validates strict task entities and optimistic mutation operations", () => {
    expect(taskSchema.parse(TASK)).toEqual(TASK);
    expect(taskRecordSchema.parse({ ...TASK, updatedBy: USER_ID })).toMatchObject({
      updatedBy: USER_ID,
    });
    expect(() => taskSchema.parse({ ...TASK, rank: "0" })).toThrow();
    expect(() => taskSchema.parse({ ...TASK, dueOn: "08/15/2026" })).toThrow();
    expect(() => taskSchema.parse({ ...TASK, secret: true })).toThrow();

    expect(
      createTaskOperationSchema.parse({
        conversationId: CONVERSATION_ID,
        idempotencyKey: TASK_ID,
        title: "  Follow up  ",
      }),
    ).toMatchObject({
      title: "Follow up",
      description: null,
      priority: "none",
      assigneeId: null,
      dueOn: null,
      sourceMessageId: null,
    });
    expect(
      updateTaskOperationSchema.parse({
        taskId: TASK_ID,
        idempotencyKey: MESSAGE_ID,
        expectedVersion: 1,
        title: TASK.title,
        description: null,
        priority: "urgent",
        assigneeId: null,
        dueOn: null,
      }),
    ).toMatchObject({ taskId: TASK_ID, expectedVersion: 1 });
    expect(() =>
      moveTaskOperationSchema.parse({
        taskId: TASK_ID,
        idempotencyKey: MESSAGE_ID,
        expectedVersion: 1,
        status: "done",
        beforeTaskId: TASK_ID,
      }),
    ).toThrow();
  });
});

describe("agent contracts", () => {
  const agentUser = {
    id: USER_ID,
    kind: "agent",
    username: "hermes",
    displayName: "Hermes",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("keeps human principals unchanged and gives agents a distinct scoped arm", () => {
    expect(currentPrincipalSchema.parse(BOOTSTRAP.currentUser)).toEqual({
      ...BOOTSTRAP.currentUser,
      user: { ...BOOTSTRAP.currentUser.user, kind: "human", title: null },
    });
    expect(
      currentAgentPrincipalSchema.parse({
        type: "agent",
        user: agentUser,
        workspaceId: WORKSPACE_ID,
        role: "member",
        scopes: ["workspace:read", "messages:write"],
      }),
    ).toMatchObject({ type: "agent", user: { username: "hermes" } });
    expect(() =>
      currentAgentPrincipalSchema.parse({
        type: "agent",
        user: agentUser,
        workspaceId: WORKSPACE_ID,
        role: "owner",
        scopes: ["workspace:read"],
      }),
    ).toThrow();
  });

  it("validates prefixed secrets, default scopes, unique scopes, and secret-free metadata", () => {
    const secret = `hype_comms_agent_${"a".repeat(43)}`;
    expect(agentTokenSecretSchema.parse(secret)).toBe(secret);
    expect(() => agentTokenSecretSchema.parse("a".repeat(43))).toThrow();
    expect(createAgentTokenRequestSchema.parse({ label: "Gateway" })).toEqual({
      label: "Gateway",
      scopes: ["workspace:read", "messages:write"],
    });
    expect(() =>
      createAgentTokenRequestSchema.parse({
        label: "Gateway",
        scopes: ["workspace:read", "workspace:read"],
      }),
    ).toThrow();

    const metadata = {
      id: MESSAGE_ID,
      agentUserId: USER_ID,
      label: "Gateway",
      scopes: ["workspace:read", "messages:write"],
      createdBy: USER_ID,
      createdAt: NOW,
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(agentTokenMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() => agentTokenMetadataSchema.parse({ ...metadata, token: secret })).toThrow();
  });

  it("pins strict child enrollment requests and the exact default-agency-v1 profile", () => {
    const credentialVerifier = Buffer.alloc(32, 7).toString("base64url");
    const request = requestAgentEnrollmentSchema.parse({
      username: "mira-child",
      displayName: "Mira Child",
      label: "Mira child default agency",
      credentialVerifier,
      restrictedChannelIds: [CONVERSATION_ID],
    });
    expect(request.credentialVerifier).toBe(credentialVerifier);
    expect(DEFAULT_AGENCY_AGENT_SCOPES).toEqual([
      "workspace:read",
      "messages:write",
      "direct-conversations:write",
      "agents:invite",
    ]);
    expect(DEFAULT_AGENT_AGENCY_PROFILE).toBe("default-agency-v1");
    expect(() => requestAgentEnrollmentSchema.parse({ ...request, unexpected: true })).toThrow();
    expect(() =>
      requestAgentEnrollmentSchema.parse({
        ...request,
        restrictedChannelIds: [CONVERSATION_ID, CONVERSATION_ID],
      }),
    ).toThrow();
    expect(() => agentEnrollmentCredentialVerifierSchema.parse("a".repeat(43))).toThrow();

    const enrollment = {
      id: MESSAGE_ID,
      workspaceId: WORKSPACE_ID,
      profile: DEFAULT_AGENT_AGENCY_PROFILE,
      status: "pending_approval",
      username: request.username,
      displayName: request.displayName,
      label: request.label,
      requestedBy: USER_ID,
      requestedByKind: "agent",
      restrictedChannelIds: request.restrictedChannelIds,
      expiresAt: NOW,
      reviewedBy: null,
      reviewedAt: null,
      activatedAgentUserId: null,
      activatedAgentTokenId: null,
      activatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(agentEnrollmentSchema.parse(enrollment)).toEqual(enrollment);
    expect(() =>
      agentEnrollmentSchema.parse({
        ...enrollment,
        status: "active",
      }),
    ).toThrow();
  });

  it("represents active and disabled agent records without adding fields to public users", () => {
    expect(
      agentUserSchema.parse({
        user: agentUser,
        workspaceId: WORKSPACE_ID,
        role: "member",
        status: "active",
        createdBy: USER_ID,
        createdAt: NOW,
        disabledAt: null,
      }),
    ).toMatchObject({ status: "active" });
    expect(() =>
      agentUserSchema.parse({
        user: agentUser,
        workspaceId: WORKSPACE_ID,
        role: "member",
        status: "disabled",
        createdBy: USER_ID,
        createdAt: NOW,
        disabledAt: null,
      }),
    ).toThrow();
  });
});

describe("channel slugs", () => {
  it("normalizes names while preserving Unicode letters, numbers, and combining marks", () => {
    expect(channelSlugFromName(" Café Déjà Vu ")).toBe("café-déjà-vu");
    expect(channelSlugFromName("產品 設計")).toBe("產品-設計");
    expect(channelSlugFromName("हिन्दी टीम")).toBe("हिन्दी-टीम");
    expect(channelSlugFromName("ＦＵＬＬ　ＷＩＤＴＨ")).toBe("full-width");
    expect(channelSlugFromName("Ops / EU -- 2026")).toBe("ops-eu-2026");
  });

  it("rejects noncanonical, overlength, and emoji-only slugs", () => {
    expect(channelSlugFromName("👋✨")).toBe("");
    expect(() => channelSlugSchema.parse("CAFÉ")).toThrow();
    expect(() => channelSlugSchema.parse("cafe\u0301")).toThrow();
    expect(() => channelSlugSchema.parse("alpha--team")).toThrow();
    expect(() => channelSlugSchema.parse(`a${"界".repeat(100)}`)).toThrow();
    expect(channelSlugSchema.parse("équipe-產品-हिन्दी")).toBe("équipe-產品-हिन्दी");
  });

  it("caps generated slugs at 100 Unicode code points", () => {
    const slug = channelSlugFromName("界".repeat(120));
    expect([...slug]).toHaveLength(100);
    expect(channelSlugSchema.parse(slug)).toBe(slug);
  });
});

describe("transport contracts", () => {
  it("validates display names and conversation summaries", () => {
    expect(displayNameSchema.parse("  Morgan  ")).toBe("Morgan");
    expect(() => displayNameSchema.parse("Morgan\nAdmin")).toThrow();

    expect(
      conversationSummarySchema.parse({
        conversation: {
          id: CONVERSATION_ID,
          workspaceId: WORKSPACE_ID,
          kind: "channel",
          name: "General",
          slug: "general",
          topic: null,
          access: "workspace",
          isArchived: false,
          createdBy: USER_ID,
          createdAt: NOW,
          updatedAt: NOW,
        },
        participantIds: [],
        membershipRole: null,
        lastMessage: null,
        unreadCount: 0,
        mentionCount: 0,
        readCursor: null,
      }),
    ).toMatchObject({ conversation: { slug: "general" } });
  });

  it("upgrades legacy workspace-channel cache records without relaxing strict fields", () => {
    const legacy = {
      ...CONVERSATION_SUMMARY,
      conversation: {
        ...CONVERSATION_SUMMARY.conversation,
        access: undefined,
      },
      membershipRole: undefined,
    };
    expect(conversationSummarySchema.parse(legacy)).toMatchObject({
      conversation: { access: null },
      membershipRole: null,
    });
    expect(() => conversationSummarySchema.parse({ ...legacy, unexpected: true })).toThrow();
  });

  it("keeps the session state discriminated and free of credentials", () => {
    expect(chatSessionStateSchema.parse({ status: "signed-out" })).toEqual({
      status: "signed-out",
    });
    expect(
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "email",
        name: "Morgan",
        email: "MORGAN@example.com",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).toEqual({
      status: "signed-in",
      method: "email",
      name: "Morgan",
      email: "morgan@example.com",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(() =>
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "email",
        name: "Morgan",
        email: "morgan@example.com",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        token: "x",
      }),
    ).toThrow();
    expect(() => chatSessionStateSchema.parse({ status: "signed-in" })).toThrow();

    const offline = {
      status: "session-unavailable",
      reason: "server_unreachable",
      message: "Could not reach the chat server. Your session is preserved.",
      lastAuthenticatedSession: {
        method: "email",
        name: "Morgan",
        email: "MORGAN@example.com",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      },
    } as const;
    expect(chatSessionStateSchema.parse(offline)).toEqual({
      ...offline,
      lastAuthenticatedSession: {
        ...offline.lastAuthenticatedSession,
        email: "morgan@example.com",
      },
    });
    expect(() =>
      chatSessionStateSchema.parse({
        ...offline,
        lastAuthenticatedSession: {
          ...offline.lastAuthenticatedSession,
          credentialFingerprint: "must-never-cross-ipc",
        },
      }),
    ).toThrow();
  });

  it("keeps update state bounded and free of updater diagnostics", () => {
    expect(updateStateSchema.parse({ status: "downloading", percentage: 42 })).toEqual({
      status: "downloading",
      percentage: 42,
    });
    expect(updateStateSchema.parse({ status: "ready", version: "1.2.3-beta.1" })).toEqual({
      status: "ready",
      version: "1.2.3-beta.1",
    });
    expect(() => updateStateSchema.parse({ status: "downloading", percentage: 42.5 })).toThrow();
    expect(() =>
      updateStateSchema.parse({ status: "error", message: "Raw updater failure" }),
    ).toThrow();
    expect(() =>
      updateStateSchema.parse({
        status: "error",
        message: "Update failed",
        feedUrl: "https://updates.example/private",
      }),
    ).toThrow();
    expect(() => updateVersionSchema.parse("../unsigned/app.zip")).toThrow();
    expect(() => updateVersionSchema.parse("1".repeat(65))).toThrow();
  });

  it("validates the stable API error envelope", () => {
    expect(
      apiErrorEnvelopeSchema.parse({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid input",
          requestId: "request-1",
          details: [{ field: "name", issue: "Required" }],
        },
      }),
    ).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("coerces bounded HTTP query parameters from URL strings", () => {
    expect(messageHistoryQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(messageThreadRequestSchema.parse({ messageId: MESSAGE_ID, limit: "25" })).toEqual({
      messageId: MESSAGE_ID,
      limit: 25,
    });
    expect(() => messageThreadRequestSchema.parse({ messageId: "not-a-uuid" })).toThrow();
    expect(messageSearchQuerySchema.parse({ query: "  quarterly avalanche  " })).toEqual({
      query: "quarterly avalanche",
      limit: 25,
    });
    expect(() => messageSearchQuerySchema.parse({ query: "q" })).toThrow();
    expect(() => messageSearchQuerySchema.parse({ query: "quarterly", limit: "51" })).toThrow();
    expect(() =>
      messageSearchQuerySchema.parse({ query: "quarterly", workspaceId: WORKSPACE_ID }),
    ).toThrow();
    expect(syncQuerySchema.parse({ after: "4", limit: "100" })).toEqual({
      after: "4",
      limit: 100,
    });
    expect(taskListQuerySchema.parse({ limit: "200" })).toEqual({ limit: 200 });
    expect(
      taskListQuerySchema.parse({
        status: "in_progress",
        priority: "urgent",
        assignee: "me",
        dueAfter: "2026-08-01",
        dueBefore: "2026-08-31",
        updatedAfter: NOW,
        updatedBy: USER_ID,
      }),
    ).toEqual({
      status: "in_progress",
      priority: "urgent",
      assignee: "me",
      dueAfter: "2026-08-01",
      dueBefore: "2026-08-31",
      updatedAfter: NOW,
      updatedBy: USER_ID,
      limit: 100,
    });
    expect(() => taskListQuerySchema.parse({ limit: "201" })).toThrow();
    expect(() =>
      taskListQuerySchema.parse({ dueAfter: "2026-09-01", dueBefore: "2026-08-01" }),
    ).toThrow();
    expect(() => taskListQuerySchema.parse({ assignee: "someone" })).toThrow();
    expect(() => syncQuerySchema.parse({ after: "4", limit: "101" })).toThrow();
  });

  it("validates the distinct bounded context-pack history query", () => {
    expect(agentContextHistoryQuerySchema.parse({ contextPack: "true" })).toEqual({
      contextPack: true,
      limit: AGENT_CONTEXT_PACK_DEFAULT_LIMIT,
    });
    expect(
      agentContextHistoryQuerySchema.parse({
        contextPack: true,
        throughMessageId: MESSAGE_ID,
        limit: String(AGENT_CONTEXT_PACK_MAX_LIMIT),
      }),
    ).toEqual({
      contextPack: true,
      throughMessageId: MESSAGE_ID,
      limit: AGENT_CONTEXT_PACK_MAX_LIMIT,
    });
    expect(() =>
      agentContextHistoryQuerySchema.parse({
        contextPack: "true",
        throughMessageId: MESSAGE_ID,
        before: "cursor",
      }),
    ).toThrow();
    expect(() =>
      agentContextHistoryQuerySchema.parse({
        contextPack: "true",
        limit: AGENT_CONTEXT_PACK_MAX_LIMIT + 1,
      }),
    ).toThrow();
    expect(() => agentContextHistoryQuerySchema.parse({ contextPack: "false" })).toThrow();
  });

  it("rejects pagination metadata on an empty context pack", () => {
    const emptyPack = {
      version: 1,
      conversation: {
        id: CONVERSATION_ID,
        kind: "channel",
        slug: "general",
        selector: "#general",
      },
      anchorMessageId: null,
      messages: [],
      threadRoot: null,
      replyTarget: null,
      readThroughMessageId: null,
      truncatedBefore: false,
      nextCursor: null,
    } as const;

    expect(agentContextHistoryResponseSchema.safeParse({ contextPack: emptyPack }).success).toBe(
      true,
    );
    expect(
      agentContextHistoryResponseSchema.safeParse({
        contextPack: { ...emptyPack, truncatedBefore: true, nextCursor: "cursor" },
      }).success,
    ).toBe(false);
  });

  it("validates canonical chronological channel context packs", () => {
    const author = {
      id: USER_ID,
      kind: "human",
      username: "morgan",
      displayName: "Morgan",
    } as const;
    const root = {
      id: MESSAGE_ID,
      conversationSequence: "1",
      createdAt: NOW,
      body: "Root",
      author,
      mentionedYou: false,
      threadRootId: null,
    } as const;
    const reply = {
      ...root,
      id: REPLY_ID,
      conversationSequence: "2",
      body: "@helper take a look",
      mentionedYou: true,
      threadRootId: MESSAGE_ID,
    } as const;
    const response = {
      contextPack: {
        version: 1,
        conversation: {
          id: CONVERSATION_ID,
          kind: "channel",
          slug: "general",
          selector: "#general",
        },
        anchorMessageId: REPLY_ID,
        messages: [reply],
        threadRoot: root,
        replyTarget: {
          kind: "thread",
          conversationId: CONVERSATION_ID,
          rootMessageId: MESSAGE_ID,
        },
        readThroughMessageId: REPLY_ID,
        truncatedBefore: true,
        nextCursor: "cursor",
      },
    } as const;

    expect(agentContextHistoryResponseSchema.parse(response)).toEqual(response);
    const astralSlug = "𐐨".repeat(51);
    const astralResponse = {
      contextPack: {
        ...response.contextPack,
        conversation: {
          ...response.contextPack.conversation,
          slug: astralSlug,
          selector: `#${astralSlug}`,
        },
      },
    } as const;
    expect(agentContextHistoryResponseSchema.parse(astralResponse)).toEqual(astralResponse);
    const edgeStringResponse = {
      contextPack: {
        ...response.contextPack,
        messages: [
          {
            ...reply,
            createdAt: "0000-02-29T23:59:59.123456789Z",
            body: "\ud800",
          },
        ],
      },
    } as const;
    expect(agentContextHistoryResponseSchema.parse(edgeStringResponse)).toEqual(edgeStringResponse);
    expect(() =>
      agentContextHistoryResponseSchema.parse({
        ...response,
        contextPack: {
          ...response.contextPack,
          conversation: { ...response.contextPack.conversation, selector: "#renamed" },
        },
      }),
    ).toThrow();
    expect(() =>
      agentContextHistoryResponseSchema.parse({
        ...response,
        contextPack: { ...response.contextPack, messages: [reply, root] },
      }),
    ).toThrow();
  });

  it("measures compact JSON with only injection-sensitive line separators escaped", () => {
    const value = { body: "\u0084\u0085\u2028\u2029\u202a\n" };
    const rawByteLength = Buffer.byteLength(JSON.stringify(value), "utf8");

    expect(injectionSafeCompactJsonByteLength(value)).toBe(rawByteLength + 10);
    expect(injectionSafeCompactJsonByteLength("\u0084\u202a\n")).toBe(
      Buffer.byteLength(JSON.stringify("\u0084\u202a\n"), "utf8"),
    );
  });

  it("validates derived direct-message context and enforces the serialized byte cap", () => {
    const message = {
      id: MESSAGE_ID,
      conversationSequence: "1",
      createdAt: NOW,
      body: "Hello",
      author: {
        id: USER_ID,
        kind: "human",
        username: "morgan",
        displayName: "Morgan",
      },
      mentionedYou: false,
      threadRootId: null,
    } as const;
    const contextPack = {
      version: 1,
      conversation: {
        id: CONVERSATION_ID,
        kind: "direct_message",
        selector: "@morgan",
        peer: message.author,
        self: false,
      },
      anchorMessageId: MESSAGE_ID,
      messages: [message],
      threadRoot: null,
      replyTarget: { kind: "flat", conversationId: CONVERSATION_ID },
      readThroughMessageId: MESSAGE_ID,
      truncatedBefore: false,
      nextCursor: null,
    } as const;

    expect(agentContextHistoryResponseSchema.parse({ contextPack })).toEqual({ contextPack });
    const sentinelPeerPack = {
      ...contextPack,
      conversation: {
        ...contextPack.conversation,
        peer: {
          ...contextPack.conversation.peer,
          id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        },
      },
    } as const;
    expect(agentContextHistoryResponseSchema.parse({ contextPack: sentinelPeerPack })).toEqual({
      contextPack: sentinelPeerPack,
    });
    expect(
      agentContextHistoryResponseSchema.safeParse({
        contextPack: {
          ...sentinelPeerPack,
          conversation: {
            ...sentinelPeerPack.conversation,
            peer: {
              ...sentinelPeerPack.conversation.peer,
              id: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
            },
          },
        },
      }).success,
    ).toBe(false);
    const oversizedMessages = Array.from({ length: AGENT_CONTEXT_PACK_MAX_LIMIT }, (_, index) => ({
      ...message,
      id: `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      conversationSequence: String(index + 1),
      body: "x".repeat(4_000),
    }));
    expect(JSON.stringify({ ...contextPack, messages: oversizedMessages }).length).toBeGreaterThan(
      AGENT_CONTEXT_PACK_MAX_BYTES,
    );
    expect(
      agentContextHistoryResponseSchema.safeParse({
        contextPack: {
          ...contextPack,
          anchorMessageId: oversizedMessages.at(-1)?.id,
          messages: oversizedMessages,
          readThroughMessageId: oversizedMessages.at(-1)?.id,
        },
      }).success,
    ).toBe(false);

    const injectionSensitiveMessages = Array.from({ length: 7 }, (_, index) => ({
      ...message,
      id: `20000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      conversationSequence: String(index + 1),
      body: "\u0085\u2028\u2029".repeat(1_000),
    }));
    const injectionSensitivePack = {
      ...contextPack,
      anchorMessageId: injectionSensitiveMessages.at(-1)?.id,
      messages: injectionSensitiveMessages,
      readThroughMessageId: injectionSensitiveMessages.at(-1)?.id,
    };
    expect(Buffer.byteLength(JSON.stringify(injectionSensitivePack), "utf8")).toBeLessThanOrEqual(
      AGENT_CONTEXT_PACK_MAX_BYTES,
    );
    expect(injectionSafeCompactJsonByteLength(injectionSensitivePack)).toBeGreaterThan(
      AGENT_CONTEXT_PACK_MAX_BYTES,
    );
    expect(
      agentContextHistoryResponseSchema.safeParse({
        contextPack: injectionSensitivePack,
      }).success,
    ).toBe(false);
  });

  it("keeps reactions separate from thread-aware history", () => {
    expect(listMessageReactionsRequestSchema.parse({ messageIds: [MESSAGE_ID] })).toEqual({
      messageIds: [MESSAGE_ID],
    });
    expect(() =>
      listMessageReactionsRequestSchema.parse({ messageIds: [MESSAGE_ID, MESSAGE_ID] }),
    ).toThrow();
    expect(
      messageHistoryResponseSchema.parse({
        messages: [],
        threadSummaries: [],
        threadsSupported: true,
        nextCursor: null,
      }),
    ).toEqual({
      messages: [],
      threadSummaries: [],
      threadsSupported: true,
      attachments: [],
      nextCursor: null,
    });
    expect(messageHistoryResponseSchema.parse({ messages: [], nextCursor: null })).toEqual({
      messages: [],
      threadSummaries: [],
      threadsSupported: false,
      attachments: [],
      nextCursor: null,
    });
    expect(() =>
      messageHistoryResponseSchema.parse({
        messages: [],
        threadSummaries: [],
        reactions: [],
        nextCursor: null,
      }),
    ).toThrow();
    expect(messageReactionTargetSchema.parse({ messageId: MESSAGE_ID, emoji: "👩🏽‍💻" })).toEqual({
      messageId: MESSAGE_ID,
      emoji: "👩🏽‍💻",
    });
    expect(() =>
      messageReactionTargetSchema.parse({ messageId: MESSAGE_ID, emoji: "shipit" }),
    ).toThrow();
  });

  it("validates one-level thread projections", () => {
    const root = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      conversationSequence: "1",
      version: 1,
      clientMessageId: MESSAGE_ID,
      authorId: USER_ID,
      threadRootId: null,
      body: "Root",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    const reply = {
      ...root,
      id: REPLY_ID,
      clientMessageId: REPLY_ID,
      conversationSequence: "2",
      threadRootId: MESSAGE_ID,
      body: "Reply",
    } as const;

    expect(
      messageHistoryResponseSchema.parse({ messages: [root, reply], nextCursor: null }),
    ).toEqual({
      messages: [root, reply],
      threadSummaries: [],
      threadsSupported: false,
      attachments: [],
      nextCursor: null,
    });
    expect(
      messageHistoryResponseSchema.parse({
        messages: [root],
        threadSummaries: [{ threadRootId: MESSAGE_ID, replyCount: 1, latestReply: reply }],
        nextCursor: null,
      }),
    ).toMatchObject({
      threadSummaries: [{ threadRootId: MESSAGE_ID, replyCount: 1 }],
      threadsSupported: false,
    });
    expect(
      messageThreadResponseSchema.parse({ root, replies: [reply], nextCursor: null }),
    ).toMatchObject({ root: { id: MESSAGE_ID }, replies: [{ id: REPLY_ID }] });
    expect(() =>
      messageThreadResponseSchema.parse({
        root: reply,
        replies: [],
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      messageThreadResponseSchema.parse({
        root,
        replies: [{ ...reply, threadRootId: REPLY_ID }],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("validates the initial realtime handshake event", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000005",
      type: "system.connected",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      workspaceSequence: "42",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        connectionId: "10000000-0000-4000-8000-000000000006",
        userId: USER_ID,
      },
    } as const;

    expect(systemConnectedEventSchema.parse(event)).toMatchObject({ type: "system.connected" });
    expect(() =>
      systemConnectedEventSchema.parse({ ...event, conversationSequence: "1" }),
    ).toThrow();
  });

  it("rejects conversation events whose canonical entity contradicts the envelope or type", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000005",
      type: "channel.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "42",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        conversation: CONVERSATION_SUMMARY.conversation,
        participantIds: [],
      },
    } as const;

    expect(workspaceEventSchema.parse(event)).toEqual({
      ...event,
      payload: {
        ...event.payload,
        conversation: { ...event.payload.conversation, channelMode: "chat" },
      },
    });
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          conversation: { ...event.payload.conversation, id: MESSAGE_ID },
        },
      }),
    ).toThrow();
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          conversation: { ...event.payload.conversation, workspaceId: MESSAGE_ID },
        },
      }),
    ).toThrow();
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          conversation: { ...event.payload.conversation, isArchived: true },
        },
      }),
    ).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, type: "channel.archived" })).toThrow();
    expect(
      workspaceEventSchema.parse({
        ...event,
        type: "channel.archived",
        payload: {
          ...event.payload,
          conversation: { ...event.payload.conversation, isArchived: true },
        },
      }),
    ).toMatchObject({ type: "channel.archived" });
    expect(() =>
      workspaceEventSchema.parse({ ...event, type: "direct_conversation.created" }),
    ).toThrow();
  });

  it("rejects message events whose canonical entity contradicts the envelope", () => {
    const message = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      conversationSequence: "42",
      version: 1,
      clientMessageId: MESSAGE_ID,
      authorId: USER_ID,
      threadRootId: null,
      body: "Envelope consistency",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000005",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "43",
      conversationSequence: "42",
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { message, mentionedUserIds: [] },
    } as const;

    expect(workspaceEventSchema.parse(event)).toEqual(event);
    expect(
      workspaceEventSchema.parse({
        ...event,
        payload: {
          message: { ...event.payload.message, threadRootId: USER_ID },
          mentionedUserIds: [],
          recipientNotificationReason: "participated_thread_reply",
        },
      }),
    ).toMatchObject({
      payload: { recipientNotificationReason: "participated_thread_reply" },
    });
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: { ...event.payload, recipientNotificationReason: "local_guess" },
      }),
    ).toThrow();
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          recipientNotificationReason: "participated_thread_reply",
        },
      }),
    ).toThrow();
    for (const candidate of [
      { ...event, conversationId: MESSAGE_ID },
      { ...event, conversationSequence: "41" },
      { ...event, entityVersion: 2 },
    ]) {
      expect(() => workspaceEventSchema.parse(candidate)).toThrow();
    }
  });

  it("validates reaction sync events with their target message sequence", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000006",
      type: "reaction.added",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "43",
      conversationSequence: "42",
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        reaction: {
          id: REACTION_ID,
          messageId: MESSAGE_ID,
          userId: USER_ID,
          emoji: "🎉",
          createdAt: NOW,
        },
      },
    } as const;

    expect(workspaceEventSchema.parse(event)).toMatchObject({ type: "reaction.added" });
    expect(workspaceEventSchema.parse({ ...event, type: "reaction.removed" })).toMatchObject({
      type: "reaction.removed",
    });
    expect(() => workspaceEventSchema.parse({ ...event, conversationSequence: null })).toThrow();
  });

  it("validates message.retracted as a body-free tombstone", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000016",
      type: "message.retracted",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "44",
      conversationSequence: "42",
      entityVersion: 2,
      delivery: "at_least_once",
      payload: {
        messageId: MESSAGE_ID,
        deletedAt: NOW,
      },
    } as const;

    expect(workspaceEventSchema.parse(event)).toEqual(event);
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: { ...event.payload, body: "" },
      }),
    ).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, conversationSequence: null })).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, type: "message.deleted" })).toThrow();
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: { messageId: MESSAGE_ID },
      }),
    ).toThrow();
  });

  it("keeps member.updated a bare invalidation signal that cannot express removal", () => {
    const member = {
      id: USER_ID,
      kind: "agent",
      username: "hermes",
      displayName: "Hermes",
      avatarUrl: null,
      title: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000006",
      type: "member.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      workspaceSequence: "43",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { member },
    } as const;

    expect(memberUpdatedEventSchema.parse(event)).toEqual(event);
    expect(workspaceEventSchema.parse(event)).toMatchObject({ type: "member.updated" });
    expect(Object.keys(memberUpdatedEventSchema.shape.payload.shape)).toEqual(["member"]);

    // The payload is deliberately NOT authoritative: it is a User and a User has no status flag,
    // so a disable cannot be expressed here and consumers must re-read GET /v1/members instead of
    // upserting this member. These assertions exist so a future "just add a status flag" change
    // fails loudly rather than silently reintroducing the upsert bug.
    expect(() =>
      memberUpdatedEventSchema.parse({
        ...event,
        payload: { member, removed: true },
      }),
    ).toThrow();
    expect(() =>
      memberUpdatedEventSchema.parse({
        ...event,
        payload: { member: { ...member, status: "revoked" } },
      }),
    ).toThrow();
    expect(() => userSchema.parse({ ...member, status: "revoked" })).toThrow();
    expect(() => userSchema.parse({ ...member, isActive: false })).toThrow();
    expect(() => userSchema.parse({ ...member, disabledAt: NOW })).toThrow();

    // A member.updated event is workspace-scoped: pinning these to null keeps it out of the
    // per-conversation projection paths that would tempt a consumer to patch state from it.
    expect(() =>
      memberUpdatedEventSchema.parse({ ...event, conversationId: CONVERSATION_ID }),
    ).toThrow();
    expect(() =>
      memberUpdatedEventSchema.parse({ ...event, conversationSequence: "42" }),
    ).toThrow();
  });

  it("accepts legacy and canonical read-state events but rejects partial counts", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000007",
      type: "read_cursor.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "44",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        readCursor: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
          lastReadMessageId: MESSAGE_ID,
          lastReadConversationSequence: "42",
          lastReadAt: NOW,
          updatedAt: NOW,
        },
      },
    } as const;

    expect(workspaceEventSchema.parse(event)).toMatchObject({ payload: event.payload });
    expect(
      workspaceEventSchema.parse({
        ...event,
        payload: { ...event.payload, unreadCount: 2, mentionCount: 1 },
      }),
    ).toMatchObject({ payload: { unreadCount: 2, mentionCount: 1 } });
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: { ...event.payload, unreadCount: 2 },
      }),
    ).toThrow();
    expect(() =>
      workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          readCursor: { ...event.payload.readCursor, conversationId: MESSAGE_ID },
        },
      }),
    ).toThrow();
  });

  it("validates versioned task events without a message sequence", () => {
    const event = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000007",
      type: "task.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "45",
      conversationSequence: null,
      entityVersion: TASK.version,
      delivery: "at_least_once",
      payload: { task: TASK },
    } as const;

    expect(workspaceEventSchema.parse(event)).toEqual(event);
    expect(workspaceEventSchema.parse({ ...event, type: "task.created" })).toMatchObject({
      type: "task.created",
    });
    expect(() => workspaceEventSchema.parse({ ...event, conversationSequence: "42" })).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, workspaceId: MESSAGE_ID })).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, conversationId: MESSAGE_ID })).toThrow();
    expect(() => workspaceEventSchema.parse({ ...event, entityVersion: 2 })).toThrow();
  });

  it("validates bounded client capability headers", () => {
    expect(
      clientCapabilitiesHeaderSchema.parse(
        `${REACTION_EVENTS_CAPABILITY}, ${READ_STATE_EVENTS_CAPABILITY}, ${TASK_EVENTS_CAPABILITY}, ${THREADS_CAPABILITY}, ${PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY}, ${ATTACHMENTS_CAPABILITY}, ${MESSAGE_RETRACT_EVENTS_CAPABILITY}, ${AGENT_CONTEXT_PACK_CAPABILITY}`,
      ),
    ).toEqual([
      REACTION_EVENTS_CAPABILITY,
      READ_STATE_EVENTS_CAPABILITY,
      TASK_EVENTS_CAPABILITY,
      THREADS_CAPABILITY,
      PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
      ATTACHMENTS_CAPABILITY,
      MESSAGE_RETRACT_EVENTS_CAPABILITY,
      AGENT_CONTEXT_PACK_CAPABILITY,
    ]);
    for (const value of ["", "reaction events", "Reaction-Events", "a".repeat(513)]) {
      expect(() => clientCapabilitiesHeaderSchema.parse(value)).toThrow();
    }
  });

  it("rejects unsafe sequence and blank message values", () => {
    expect(() =>
      messageSchema.parse({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "0042",
        version: 1,
        clientMessageId: MESSAGE_ID,
        authorId: USER_ID,
        threadRootId: null,
        body: "   ",
        bodyFormat: "hype_comms_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it("bounds decimal bigint values while accepting the PostgreSQL maximum", () => {
    const maximum = "9223372036854775807";
    expect(taskNumberSchema.parse(maximum)).toBe(maximum);
    expect(() => taskNumberSchema.parse("9223372036854775808")).toThrow();
    expect(entityVersionSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => entityVersionSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("requires a UUID clientMessageId for idempotent sends", () => {
    expect(
      sendMessageRequestSchema.parse({
        conversationId: CONVERSATION_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: MESSAGE_ID,
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    ).toMatchObject({ clientMessageId: MESSAGE_ID });

    expect(() =>
      sendMessageRequestSchema.parse({
        conversationId: CONVERSATION_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: "message-1",
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    ).toThrow();

    expect(
      sendMessageOperationSchema.parse({
        conversationId: CONVERSATION_ID,
        idempotencyKey: MESSAGE_ID,
        message: {
          threadRootId: null,
          body: "Hello",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: MESSAGE_ID,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      }),
    ).toMatchObject({ conversationId: CONVERSATION_ID });

    expect(() =>
      sendMessageOperationSchema.parse({
        conversationId: CONVERSATION_ID,
        idempotencyKey: USER_ID,
        message: {
          threadRootId: null,
          body: "Hello",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: MESSAGE_ID,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      }),
    ).toThrow();
  });

  it("keeps a validated idempotency key with a channel creation operation", () => {
    const operation = createChannelOperationSchema.parse({
      name: "Alpha Team",
      slug: "alpha-team",
      topic: null,
      access: "members",
      idempotencyKey: MESSAGE_ID,
    });

    expect(operation).toMatchObject({ slug: "alpha-team", idempotencyKey: MESSAGE_ID });
    expect(() =>
      createChannelOperationSchema.parse({ ...operation, idempotencyKey: "bad key" }),
    ).toThrow();
    expect(() => createChannelOperationSchema.parse({ ...operation, unexpected: true })).toThrow();
  });

  it("accepts a staged file upload and rejects executables at the name/type boundary", () => {
    const request = createFileUploadRequestSchema.parse({
      conversationId: CONVERSATION_ID,
      fileName: "clip.webm",
      contentType: "video/webm",
      sizeBytes: 2048,
      contentSha256: "a".repeat(64),
    });
    expect(request.fileName).toBe("clip.webm");
    expect(() =>
      createFileUploadRequestSchema.parse({
        ...request,
        fileName: "nested/clip.webm",
      }),
    ).toThrow();
    expect(() =>
      createFileUploadRequestSchema.parse({
        ...request,
        sizeBytes: 26 * 1024 * 1024,
      }),
    ).toThrow();
  });

  it("paginates conversation listing instead of capping it above what the server can return", () => {
    expect(listConversationsQuerySchema.parse({})).toEqual({
      limit: CONVERSATION_PAGE_DEFAULT_LIMIT,
    });
    expect(listConversationsQuerySchema.parse({ after: "abc", limit: "100" })).toEqual({
      after: "abc",
      limit: CONVERSATION_PAGE_MAX_LIMIT,
    });
    expect(() =>
      listConversationsQuerySchema.parse({ limit: String(CONVERSATION_PAGE_MAX_LIMIT + 1) }),
    ).toThrow();

    expect(
      listConversationsResponseSchema.parse({
        conversations: [CONVERSATION_SUMMARY],
        nextCursor: "abc",
        hasMore: true,
      }),
    ).toMatchObject({ hasMore: true });
    // The unpaginated M2 shape must no longer validate, so no caller can silently keep it.
    expect(() =>
      listConversationsResponseSchema.parse({ conversations: [CONVERSATION_SUMMARY] }),
    ).toThrow();
    expect(
      listConversationsResponseSchema.safeParse({
        conversations: Array.from({ length: CONVERSATION_PAGE_MAX_LIMIT + 1 }, () => ({
          ...CONVERSATION_SUMMARY,
        })),
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("requires the bootstrap conversation page cursor so the 501st conversation cannot 500", () => {
    expect(workspaceBootstrapResponseSchema.parse(BOOTSTRAP)).toMatchObject({
      conversationsHasMore: false,
      conversationsNextCursor: null,
    });
    expect(
      workspaceBootstrapResponseSchema.parse({
        ...BOOTSTRAP,
        conversationsNextCursor: "abc",
        conversationsHasMore: true,
      }),
    ).toMatchObject({ conversationsNextCursor: "abc" });

    const { conversationsNextCursor, conversationsHasMore, ...unpaginated } = BOOTSTRAP;
    expect(conversationsNextCursor).toBeNull();
    expect(conversationsHasMore).toBe(false);
    expect(() => workspaceBootstrapResponseSchema.parse(unpaginated)).toThrow();
    const overflowing = Array.from({ length: CONVERSATION_PAGE_MAX_LIMIT + 1 }, () => ({
      ...CONVERSATION_SUMMARY,
    }));
    expect(
      workspaceBootstrapResponseSchema.safeParse({ ...BOOTSTRAP, conversations: overflowing })
        .success,
    ).toBe(false);
    // The desktop aggregate is where more than one page of conversations may accumulate.
    expect(
      workspaceSnapshotSchema.safeParse({ ...unpaginated, conversations: overflowing }).success,
    ).toBe(true);
  });

  it("gives a sync attempt a permanent arm and a Retry-After so it cannot stall forever", () => {
    expect(
      syncAttemptResultSchema.parse({ status: "permanent", reason: "invalid_response" }),
    ).toEqual({ status: "permanent", reason: "invalid_response" });
    expect(syncAttemptResultSchema.parse({ status: "permanent", reason: "forbidden" })).toEqual({
      status: "permanent",
      reason: "forbidden",
    });
    expect(
      syncAttemptResultSchema.parse({
        status: "retryable",
        reason: "rate_limited",
        retryAfterMs: 1_500,
      }),
    ).toMatchObject({ retryAfterMs: 1_500 });
    // A bare retryable result is what used to swallow 403s and invalid responses.
    expect(() => syncAttemptResultSchema.parse({ status: "retryable" })).toThrow();
    expect(() =>
      syncAttemptResultSchema.parse({ status: "retryable", reason: "invalid_response" }),
    ).toThrow();
    expect(() => syncAttemptResultSchema.parse({ status: "permanent" })).toThrow();
  });

  it("reports an unreachable server as a preserved session, not a sign-out", () => {
    expect(
      chatSessionStateSchema.parse({
        status: "session-unavailable",
        reason: "server_unreachable",
        message: "Could not reach the chat server. Your session is still signed in.",
      }),
    ).toMatchObject({ status: "session-unavailable", reason: "server_unreachable" });
    expect(() =>
      chatSessionStateSchema.parse({ status: "session-unavailable", reason: "server_unreachable" }),
    ).toThrow();
    expect(() =>
      chatSessionStateSchema.parse({
        status: "session-unavailable",
        reason: "expired",
        message: "Nope",
      }),
    ).toThrow();
  });

  it("rejects non-HTTPS and credential-bearing entity URLs", () => {
    const baseUser = {
      id: USER_ID,
      username: "morgan",
      displayName: "Morgan",
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(() => userSchema.parse({ ...baseUser, avatarUrl: "javascript:alert(1)" })).toThrow();
    expect(() => userSchema.parse({ ...baseUser, avatarUrl: "file:///etc/passwd" })).toThrow();
    expect(() =>
      userSchema.parse({ ...baseUser, avatarUrl: "https://user:pass@example.com/a" }),
    ).toThrow();
    expect(
      userSchema.parse({ ...baseUser, avatarUrl: "https://cdn.example.com/avatar.png" }),
    ).toMatchObject({ avatarUrl: "https://cdn.example.com/avatar.png" });
  });
});
