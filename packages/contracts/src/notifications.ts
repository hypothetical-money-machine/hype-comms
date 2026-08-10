import { z } from "zod";

import { entityIdSchema } from "./common.js";

/** Pending click actions are memory-only and bounded so a renderer outage cannot grow the queue. */
export const NOTIFICATION_PENDING_ACTION_LIMIT = 32;

/**
 * Raw UTF-8 JSON byte caps applied before Zod parsing at each IPC boundary. The schemas remain the
 * semantic authority; these limits prevent unknown fields from turning strict parsing into an
 * unbounded allocation path.
 */
export const NOTIFICATION_ACTION_IPC_MAX_BYTES = 1_024;
export const NOTIFICATION_ACTIVITY_IPC_MAX_BYTES = 1_024;
export const NOTIFICATION_CONTEXT_IPC_MAX_BYTES = 512;
export const NOTIFICATION_PREFERENCE_IPC_MAX_BYTES = 256;
export const NOTIFICATION_STATE_IPC_MAX_BYTES = 512;
export const NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES = 512;
export const NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES = 32 * 1_024;
export const NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES = 2 * 1_024;
export const NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES = 256;

const notificationGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The device-local switch is distinct from native support and operating-system permission. */
export const notificationDevicePreferenceSchema = z.enum(["enabled", "disabled"]);

/** Message content remains hidden unless a person explicitly opts in on this device. */
export const notificationContentPreviewPreferenceSchema = z.enum(["disabled", "enabled"]);

export const notificationNativeSupportSchema = z.enum(["supported", "unsupported"]);
export const notificationOsPermissionSchema = z.enum(["granted", "denied", "unknown"]);

/** Versioned, device-local preferences. No notification content crosses this boundary. */
export const notificationPreferenceSchema = z
  .object({
    version: z.literal(1),
    devicePreference: notificationDevicePreferenceSchema,
    contentPreviewPreference: notificationContentPreviewPreferenceSchema,
  })
  .strict();

/**
 * Resolved notification state exposed to the renderer. Device intent, platform capability, and
 * operating-system permission stay separate so denial never becomes a prompt or retry loop.
 */
export const notificationStateSchema = notificationPreferenceSchema
  .extend({
    nativeSupport: notificationNativeSupportSchema,
    osPermission: notificationOsPermissionSchema,
  })
  .strict();

/**
 * Main-issued context for one renderer navigation. A renderer must echo both generations and the
 * active scope in ready/activity messages; it cannot choose the trusted values itself.
 */
export const notificationContextSchema = z.discriminatedUnion("status", [
  z
    .object({
      version: z.literal(1),
      status: z.literal("active"),
      sessionGeneration: notificationGenerationSchema,
      rendererSessionGeneration: notificationGenerationSchema,
      userId: entityIdSchema,
      workspaceId: entityIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("inactive"),
      sessionGeneration: z.null(),
      rendererSessionGeneration: notificationGenerationSchema,
      userId: z.null(),
      workspaceId: z.null(),
    })
    .strict(),
]);

/**
 * Exact, body-free click target retained by main. Every field is bound to the session that
 * received the canonical event; an action from a replaced scope must be discarded.
 */
export const notificationActionSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("open-message"),
    sessionGeneration: notificationGenerationSchema,
    userId: entityIdSchema,
    workspaceId: entityIdSchema,
    conversationId: entityIdSchema,
    messageId: entityIdSchema,
    threadRootId: entityIdSchema.nullable(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.threadRootId === action.messageId) {
      context.addIssue({
        code: "custom",
        path: ["threadRootId"],
        message: "A reply target cannot be its own thread root",
      });
    }
  });

/**
 * The renderer reports the main timeline and optional thread stream independently because both
 * can be visible at once. `tasks` and `none` deliberately carry no tail claim, so merely selecting
 * a conversation cannot suppress a notification.
 */
export const notificationActivityViewSchema = z.discriminatedUnion("pane", [
  z
    .object({
      pane: z.literal("chat"),
      conversationId: entityIdSchema,
      timelineAtLiveTail: z.boolean(),
      thread: z
        .object({
          rootId: entityIdSchema,
          atLiveTail: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      pane: z.literal("tasks"),
      conversationId: entityIdSchema,
    })
    .strict(),
  z
    .object({
      pane: z.literal("none"),
    })
    .strict(),
]);

/**
 * Bounded renderer activity report. Main binds this payload to the trusted IPC sender's
 * `webContents.id`; the renderer cannot provide or override that identity.
 */
export const notificationActivityUpdateSchema = z
  .object({
    version: z.literal(1),
    sessionGeneration: notificationGenerationSchema,
    rendererSessionGeneration: notificationGenerationSchema,
    revision: notificationGenerationSchema,
    userId: entityIdSchema,
    workspaceId: entityIdSchema,
    view: notificationActivityViewSchema,
  })
  .strict();

/**
 * Sent only after the renderer has installed its action subscriber and initialized the matching
 * workspace session. Main also binds this payload to the trusted IPC sender.
 */
export const notificationRendererReadySchema = z
  .object({
    version: z.literal(1),
    sessionGeneration: notificationGenerationSchema,
    rendererSessionGeneration: notificationGenerationSchema,
    userId: entityIdSchema,
    workspaceId: entityIdSchema,
  })
  .strict();

/** A ready handshake is a renderer-initiated request to drain its exact current scope. */
export const notificationActionDrainRequestSchema = notificationRendererReadySchema;

/**
 * Scope-bound, capacity-limited action drain. Cross-scope actions are rejected as a malformed
 * batch instead of being partially delivered.
 */
export const notificationActionDrainResponseSchema = notificationRendererReadySchema
  .extend({
    actions: z.array(notificationActionSchema).max(NOTIFICATION_PENDING_ACTION_LIMIT),
  })
  .strict()
  .superRefine((response, context) => {
    response.actions.forEach((action, index) => {
      if (
        action.sessionGeneration !== response.sessionGeneration ||
        action.userId !== response.userId ||
        action.workspaceId !== response.workspaceId
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index],
          message: "Notification action does not match the drain scope",
        });
      }
    });
  });

/**
 * Renderer acknowledgement for one exact action. Main keeps the action until this sender- and
 * generation-bound payload arrives, so a renderer crash after a drain or push cannot lose a click.
 */
export const notificationActionAcknowledgementSchema = notificationRendererReadySchema
  .extend({
    action: notificationActionSchema,
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (
      acknowledgement.action.sessionGeneration !== acknowledgement.sessionGeneration ||
      acknowledgement.action.userId !== acknowledgement.userId ||
      acknowledgement.action.workspaceId !== acknowledgement.workspaceId
    ) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Notification action does not match the acknowledgement scope",
      });
    }
  });

/** Opaque headless capture identifier. It encodes no user, workspace, target, or message data. */
export const notificationCaptureIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Headless-only request to exercise the same click path as one captured eligible outcome. */
export const notificationCaptureActivationRequestSchema = z
  .object({
    version: z.literal(1),
    captureId: notificationCaptureIdSchema,
  })
  .strict();

/** Content-free result; false covers an unknown, expired, or no-longer-authorized capture. */
export const notificationCaptureActivationResponseSchema = z
  .object({
    version: z.literal(1),
    activated: z.boolean(),
  })
  .strict();

export type NotificationDevicePreference = z.infer<typeof notificationDevicePreferenceSchema>;
export type NotificationContentPreviewPreference = z.infer<
  typeof notificationContentPreviewPreferenceSchema
>;
export type NotificationNativeSupport = z.infer<typeof notificationNativeSupportSchema>;
export type NotificationOsPermission = z.infer<typeof notificationOsPermissionSchema>;
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;
export type NotificationState = z.infer<typeof notificationStateSchema>;
export type NotificationContext = z.infer<typeof notificationContextSchema>;
export type NotificationAction = z.infer<typeof notificationActionSchema>;
export type NotificationActivityView = z.infer<typeof notificationActivityViewSchema>;
export type NotificationActivityUpdate = z.infer<typeof notificationActivityUpdateSchema>;
export type NotificationRendererReady = z.infer<typeof notificationRendererReadySchema>;
export type NotificationActionDrainRequest = z.infer<typeof notificationActionDrainRequestSchema>;
export type NotificationActionDrainResponse = z.infer<typeof notificationActionDrainResponseSchema>;
export type NotificationActionAcknowledgement = z.infer<
  typeof notificationActionAcknowledgementSchema
>;
export type NotificationCaptureId = z.infer<typeof notificationCaptureIdSchema>;
export type NotificationCaptureActivationRequest = z.infer<
  typeof notificationCaptureActivationRequestSchema
>;
export type NotificationCaptureActivationResponse = z.infer<
  typeof notificationCaptureActivationResponseSchema
>;
