import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_IPC_MAX_BYTES,
  NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
  NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
  NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
  NOTIFICATION_PENDING_ACTION_LIMIT,
  NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
  NOTIFICATION_STATE_IPC_MAX_BYTES,
  notificationActionDrainRequestSchema,
  notificationActionDrainResponseSchema,
  notificationActionAcknowledgementSchema,
  notificationActionSchema,
  notificationActivityUpdateSchema,
  notificationCaptureActivationRequestSchema,
  notificationCaptureActivationResponseSchema,
  notificationContextSchema,
  notificationPreferenceSchema,
  notificationRendererReadySchema,
  notificationStateSchema,
} from "../src/index.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_WORKSPACE_ID = "10000000-0000-4000-8000-000000000004";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000005";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000006";
const THREAD_ROOT_ID = "10000000-0000-4000-8000-000000000007";

const READY = {
  version: 1,
  sessionGeneration: 7,
  rendererSessionGeneration: 3,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
} as const;

const ACTION = {
  version: 1,
  type: "open-message",
  sessionGeneration: READY.sessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  threadRootId: THREAD_ROOT_ID,
} as const;

function messageIdFor(index: number): string {
  return `10000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`;
}

describe("native notification contracts", () => {
  it("publishes explicit positive raw IPC byte caps", () => {
    const limits = [
      NOTIFICATION_ACTION_IPC_MAX_BYTES,
      NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
      NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
      NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
      NOTIFICATION_STATE_IPC_MAX_BYTES,
      NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
      NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
      NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
      NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
    ];

    expect(limits).toHaveLength(9);
    expect(limits.every((limit) => Number.isSafeInteger(limit) && limit > 0)).toBe(true);
    expect(NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES).toBeLessThanOrEqual(256);
  });

  it("accepts an exact scope-bound, body-free message action", () => {
    expect(notificationActionSchema.parse(ACTION)).toEqual(ACTION);
    expect(
      notificationActionSchema.parse({
        ...ACTION,
        messageId: THREAD_ROOT_ID,
        threadRootId: null,
      }),
    ).toMatchObject({ threadRootId: null });
  });

  it.each([
    { ...ACTION, type: "open-channel" },
    { ...ACTION, sessionGeneration: 0 },
    { ...ACTION, sessionGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...ACTION, userId: "not-a-user-id" },
    { ...ACTION, threadRootId: MESSAGE_ID },
    { ...ACTION, title: "Morgan" },
    { ...ACTION, body: "private canary" },
    { ...ACTION, action: { type: "arbitrary" } },
  ])("rejects a stale, malformed, or expanded action", (value) => {
    expect(notificationActionSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only bounded, scope-bound action drains", () => {
    const actions = Array.from({ length: NOTIFICATION_PENDING_ACTION_LIMIT }, (_, index) => ({
      ...ACTION,
      messageId: messageIdFor(index),
    }));

    expect(
      notificationActionDrainResponseSchema.parse({
        ...READY,
        actions,
      }).actions,
    ).toHaveLength(NOTIFICATION_PENDING_ACTION_LIMIT);

    expect(
      notificationActionDrainResponseSchema.safeParse({
        ...READY,
        actions: [...actions, { ...ACTION, messageId: messageIdFor(actions.length) }],
      }).success,
    ).toBe(false);

    expect(
      notificationActionDrainResponseSchema.safeParse({
        ...READY,
        actions: [{ ...ACTION, workspaceId: OTHER_WORKSPACE_ID }],
      }).success,
    ).toBe(false);

    expect(
      notificationActionDrainResponseSchema.safeParse({
        ...READY,
        actions: [{ ...ACTION, userId: OTHER_USER_ID }],
      }).success,
    ).toBe(false);

    expect(
      notificationActionDrainResponseSchema.safeParse({
        ...READY,
        actions: [{ ...ACTION, sessionGeneration: READY.sessionGeneration + 1 }],
      }).success,
    ).toBe(false);
  });

  it("uses a strict, scope-bound renderer-ready drain request", () => {
    expect(notificationRendererReadySchema.parse(READY)).toEqual(READY);
    expect(notificationActionDrainRequestSchema.parse(READY)).toEqual(READY);

    expect(
      notificationActionDrainRequestSchema.safeParse({ ...READY, webContentsId: 42 }).success,
    ).toBe(false);
    expect(
      notificationActionDrainRequestSchema.safeParse({
        ...READY,
        rendererSessionGeneration: 0,
      }).success,
    ).toBe(false);
  });

  it("acknowledges only one exact action in the echoed renderer scope", () => {
    const acknowledgement = { ...READY, action: ACTION };
    expect(notificationActionAcknowledgementSchema.parse(acknowledgement)).toEqual(acknowledgement);

    expect(
      notificationActionAcknowledgementSchema.safeParse({
        ...acknowledgement,
        action: { ...ACTION, workspaceId: OTHER_WORKSPACE_ID },
      }).success,
    ).toBe(false);
    expect(
      notificationActionAcknowledgementSchema.safeParse({
        ...acknowledgement,
        action: { ...ACTION, userId: OTHER_USER_ID },
      }).success,
    ).toBe(false);
    expect(
      notificationActionAcknowledgementSchema.safeParse({
        ...acknowledgement,
        action: { ...ACTION, sessionGeneration: READY.sessionGeneration + 1 },
      }).success,
    ).toBe(false);
    expect(
      notificationActionAcknowledgementSchema.safeParse({
        ...acknowledgement,
        body: "private canary",
      }).success,
    ).toBe(false);
  });

  it("provides a strict main-issued active or inactive renderer context", () => {
    expect(
      notificationContextSchema.parse({
        ...READY,
        status: "active",
      }),
    ).toMatchObject({ status: "active", userId: USER_ID, workspaceId: WORKSPACE_ID });
    expect(
      notificationContextSchema.parse({
        version: 1,
        status: "inactive",
        sessionGeneration: null,
        rendererSessionGeneration: READY.rendererSessionGeneration,
        userId: null,
        workspaceId: null,
      }),
    ).toMatchObject({ status: "inactive", userId: null, workspaceId: null });

    expect(
      notificationContextSchema.safeParse({
        ...READY,
        status: "inactive",
      }).success,
    ).toBe(false);
    expect(
      notificationContextSchema.safeParse({
        version: 1,
        status: "active",
        sessionGeneration: null,
        rendererSessionGeneration: READY.rendererSessionGeneration,
        userId: null,
        workspaceId: null,
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      pane: "chat",
      conversationId: CONVERSATION_ID,
      timelineAtLiveTail: true,
      thread: null,
    },
    {
      pane: "chat",
      conversationId: CONVERSATION_ID,
      timelineAtLiveTail: false,
      thread: { rootId: THREAD_ROOT_ID, atLiveTail: true },
    },
    { pane: "tasks", conversationId: CONVERSATION_ID },
    { pane: "none" },
  ])("accepts the bounded %s activity view", (view) => {
    expect(
      notificationActivityUpdateSchema.parse({
        ...READY,
        revision: 11,
        view,
      }).view,
    ).toEqual(view);
  });

  it.each([
    {
      ...READY,
      revision: 11,
      view: {
        pane: "tasks",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
      },
    },
    {
      ...READY,
      revision: 11,
      view: {
        pane: "chat",
        conversationId: CONVERSATION_ID,
        timelineAtLiveTail: true,
        thread: null,
        messageId: MESSAGE_ID,
      },
    },
    {
      ...READY,
      revision: 0,
      view: { pane: "none" },
    },
    {
      ...READY,
      revision: 11,
      view: { pane: "chat", conversationId: "x".repeat(4_096) },
    },
  ])("rejects an ambiguous, oversized, or stale activity update", (value) => {
    expect(notificationActivityUpdateSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only an opaque headless capture ID and boolean activation result", () => {
    const request = { version: 1, captureId: "capture_0123456789abcdef" } as const;
    const response = { version: 1, activated: true } as const;

    expect(notificationCaptureActivationRequestSchema.parse(request)).toEqual(request);
    expect(notificationCaptureActivationResponseSchema.parse(response)).toEqual(response);
    expect(
      notificationCaptureActivationResponseSchema.parse({ version: 1, activated: false }),
    ).toEqual({ version: 1, activated: false });
  });

  it.each([
    { version: 1, captureId: "too-short" },
    { version: 1, captureId: "x".repeat(129) },
    { version: 1, captureId: "capture id with spaces" },
    { version: 1, captureId: "capture_0123456789abcdef", messageId: MESSAGE_ID },
    { version: 1, captureId: "capture_0123456789abcdef", body: "private canary" },
  ])("rejects a malformed or expanded capture activation request", (value) => {
    expect(notificationCaptureActivationRequestSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { version: 1, activated: "yes" },
    { version: 1, activated: true, action: ACTION },
    { version: 1, activated: true, title: "arbitrary title" },
  ])("rejects a malformed or expanded capture activation response", (value) => {
    expect(notificationCaptureActivationResponseSchema.safeParse(value).success).toBe(false);
  });

  it("keeps device preference, native support, and OS permission separate", () => {
    const preference = {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    } as const;
    const state = {
      ...preference,
      nativeSupport: "supported",
      osPermission: "unknown",
    } as const;

    expect(notificationPreferenceSchema.parse(preference)).toEqual(preference);
    expect(notificationStateSchema.parse(state)).toEqual(state);
    expect(notificationStateSchema.parse({ ...state, osPermission: "denied" })).toMatchObject({
      devicePreference: "enabled",
      nativeSupport: "supported",
      osPermission: "denied",
    });
  });

  it.each([
    {
      version: 1,
      devicePreference: "prompt",
      contentPreviewPreference: "disabled",
    },
    {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "default",
    },
    {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
      nativeSupport: "supported",
      osPermission: "unknown",
      title: "generic notification title",
    },
    {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
      nativeSupport: "supported",
      osPermission: "prompt",
    },
  ])("rejects a generic or conflated preference/state value", (value) => {
    const schema =
      "nativeSupport" in value ? notificationStateSchema : notificationPreferenceSchema;
    expect(schema.safeParse(value).success).toBe(false);
  });
});
