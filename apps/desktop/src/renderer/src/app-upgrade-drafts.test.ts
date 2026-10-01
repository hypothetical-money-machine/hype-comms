// @vitest-environment happy-dom

import { randomUUID } from "node:crypto";
import type {
  HumanWorkspaceBootstrapResponse,
  Message,
  ScopedProductRealtimeEvent,
} from "@hype-comms/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { createTestDevicePreferencesRuntime } from "./device-preferences-test-fixture";
import type { DesktopApi } from "../../shared/desktop-api";
import { App } from "./App";
import { createAppClient, createAppRuntimes } from "./app-test-fixture";
import { testPosition } from "../../shared/test-support/sync-position";

const now = "2026-09-12T00:00:00.000Z";
afterEach(cleanup);

it("retains both open composer drafts while the live runtime replaces its replay epoch", async () => {
  const userId = randomUUID(),
    workspaceId = randomUUID(),
    conversationId = randomUUID();
  const user = {
    id: userId,
    kind: "human" as const,
    username: "upgrade-owner",
    displayName: "Owner",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  };
  const session = {
    status: "signed-in" as const,
    method: "email" as const,
    name: "Owner",
    email: "upgrade@example.test",
    userId,
    workspaceId,
  };
  let position = testPosition("10");
  const nextPosition = testPosition("20", randomUUID());
  const root: Message = {
    id: randomUUID(),
    conversationId,
    conversationSequence: "1",
    version: 1,
    clientMessageId: randomUUID(),
    authorId: userId,
    threadRootId: null,
    body: "Existing thread root",
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const bootstrap = (): HumanWorkspaceBootstrapResponse => ({
    currentUser: { user, email: session.email, workspaceId, role: "owner" },
    workspace: {
      id: workspaceId,
      name: "Upgrade fixture",
      slug: "upgrade-fixture",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    },
    members: [user],
    conversations: [
      {
        conversation: {
          id: conversationId,
          workspaceId,
          kind: "channel",
          name: "General",
          slug: "general",
          topic: null,
          access: "workspace",
          channelMode: "chat",
          isArchived: false,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        participantIds: [],
        membershipRole: null,
        lastMessage: root,
        unreadCount: 0,
        mentionCount: 0,
        readCursor: null,
      },
    ],
    conversationsHasMore: false,
    conversationsNextCursor: null,
    syncCursor: position,
    featureFlags: {
      channels: true,
      directMessages: true,
      mentions: true,
      announcementChannels: false,
      humansOnlyChannels: false,
    },
  });
  let receive: (value: ScopedProductRealtimeEvent) => void = () => {
    throw new Error("No realtime subscriber");
  };
  const bootstrapCall = vi.fn(async () => bootstrap());
  let realtimeGeneration = 0;
  const prepare = vi.fn<DesktopApi["startWorkspaceRealtime"]>(async () => ({
    userId,
    workspaceId,
    epoch: ++realtimeGeneration,
  }));
  const client = createAppClient({
    session,
    bootstrap,
    overrides: {
      getWorkspaceBootstrap: bootstrapCall,
      getConversationMessages: async () => ({
        messages: [root],
        attachments: [],
        reactions: [],
        threadSummaries: [],
        threadsSupported: true,
        nextCursor: null,
        snapshotPosition: position,
      }),
      getMessageThread: async () => ({
        root,
        replies: [],
        attachments: [],
        reactions: [],
        nextCursor: null,
        snapshotPosition: position,
      }),
      startWorkspaceRealtime: prepare,
      onWorkspaceEvent: (listener) => {
        receive = listener;
        return () => undefined;
      },
      advanceReadCursor: async (_conversationId, messageId) => ({
        readCursor: {
          conversationId,
          userId,
          lastReadMessageId: messageId,
          lastReadConversationSequence: "1",
          lastReadAt: now,
          updatedAt: now,
        },
        syncCursor: position,
      }),
    },
  });
  render(
    createElement(App, {
      client,
      devicePreferences: createTestDevicePreferencesRuntime(),
      ...createAppRuntimes(client),
    }),
  );
  const main = await screen.findByPlaceholderText("Message # General");
  await screen.findByText(root.body);
  fireEvent.change(main, { target: { value: "Unsent conversation draft 😀" } });
  fireEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
  const thread = await screen.findByPlaceholderText("Reply in thread");
  fireEvent.change(thread, { target: { value: "Unsent thread draft 🦊" } });
  const priorCalls = bootstrapCall.mock.calls.length;
  await act(async () => {
    position = nextPosition;
    receive({
      scope: { userId, workspaceId, epoch: 1 },
      event: {
        version: 1,
        id: randomUUID(),
        type: "system.resync_required",
        occurredAt: now,
        workspaceId,
        conversationId: null,
        position: testPosition("10"),
        conversationSequence: null,
        entityVersion: 1,
        delivery: "at_least_once",
        payload: { reason: "cursor_expired" },
      },
    });
  });
  await waitFor(() => expect(bootstrapCall.mock.calls.length).toBeGreaterThan(priorCalls), {
    timeout: 5000,
  });
  await waitFor(() =>
    expect(prepare.mock.calls.some(([input]) => input.epoch === nextPosition.epoch)).toBe(true),
  );
  await waitFor(() =>
    expect((screen.getByPlaceholderText("Message # General") as HTMLTextAreaElement).value).toBe(
      "Unsent conversation draft 😀",
    ),
  );
  expect((screen.getByPlaceholderText("Reply in thread") as HTMLTextAreaElement).value).toBe(
    "Unsent thread draft 🦊",
  );
});
