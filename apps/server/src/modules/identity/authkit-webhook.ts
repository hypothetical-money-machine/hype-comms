import { WorkOS } from "@workos-inc/node";
import { z } from "zod";

export const WORKOS_WEBHOOK_BODY_LIMIT = 64 * 1_024;
const WORKOS_WEBHOOK_TOLERANCE_MS = 3 * 60 * 1_000;

const workOSIdentifierSchema = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 1)
    .max(255)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9]+$`));

const contextValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const contextSchema = z
  .record(z.string().min(1).max(64), contextValueSchema)
  .refine((context) => Object.keys(context).length <= 32, "Too many event context fields");

const transformedEventEnvelopeSchema = z
  .object({
    id: workOSIdentifierSchema("event_"),
    event: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9_.]+$/),
    createdAt: z.iso.datetime(),
    context: contextSchema.optional(),
    data: z.unknown(),
  })
  .strict();

const rawEventEnvelopeSchema = z
  .object({
    object: z.literal("event").optional(),
    id: workOSIdentifierSchema("event_"),
    event: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9_.]+$/),
    created_at: z.iso.datetime(),
    context: contextSchema.optional(),
    data: z.unknown(),
  })
  .strict();

const transformedRevokedSessionSchema = z
  .object({
    object: z.literal("session"),
    id: workOSIdentifierSchema("session_"),
  })
  .passthrough();

const rawRevokedSessionSchema = z
  .object({
    object: z.literal("session"),
    id: workOSIdentifierSchema("session_"),
  })
  .passthrough();

const transformedSessionRevokedEventSchema = transformedEventEnvelopeSchema.extend({
  event: z.literal("session.revoked"),
  data: transformedRevokedSessionSchema,
});

const rawSessionRevokedEventSchema = rawEventEnvelopeSchema.extend({
  event: z.literal("session.revoked"),
  data: rawRevokedSessionSchema,
});

interface WorkOSEventVerifier {
  constructEvent(options: {
    readonly payload: string;
    readonly sigHeader: string;
    readonly secret: string;
    readonly tolerance: number;
  }): Promise<unknown>;
}

export interface WorkOSSessionRevokedEventStore {
  applyWorkOSSessionRevokedEvent(input: {
    readonly eventId: string;
    readonly workosSessionId: string;
    readonly occurredAt: Date;
    readonly now: Date;
  }): Promise<boolean>;
}

export type WorkOSWebhookResult = "processed" | "duplicate" | "ignored";

export interface WorkOSWebhookProcessor {
  process(input: {
    readonly payload: string;
    readonly signature: string;
  }): Promise<WorkOSWebhookResult>;
}

export class WorkOSWebhookRejectedError extends Error {
  constructor() {
    super("WorkOS webhook was rejected");
    this.name = "WorkOSWebhookRejectedError";
  }
}

export class WorkOSWebhookUnavailableError extends Error {
  constructor() {
    super("WorkOS webhook processing is unavailable");
    this.name = "WorkOSWebhookUnavailableError";
  }
}

/**
 * Verifies the exact raw request before trusting the SDK-transformed event. Cross-checking the
 * raw and transformed envelopes prevents a future SDK transformation from widening what this
 * narrow revocation consumer accepts.
 */
export class VerifiedWorkOSWebhookProcessor implements WorkOSWebhookProcessor {
  readonly #verifier: WorkOSEventVerifier;
  readonly #clientId: string;
  readonly #secret: string;
  readonly #store: WorkOSSessionRevokedEventStore;
  readonly #now: () => Date;

  constructor(options: {
    readonly verifier: WorkOSEventVerifier;
    readonly clientId: string;
    readonly secret: string;
    readonly store: WorkOSSessionRevokedEventStore;
    readonly now?: () => Date;
  }) {
    this.#verifier = options.verifier;
    this.#clientId = options.clientId;
    this.#secret = options.secret;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  async process(input: {
    readonly payload: string;
    readonly signature: string;
  }): Promise<WorkOSWebhookResult> {
    let transformedEvent: unknown;
    try {
      transformedEvent = await this.#verifier.constructEvent({
        payload: input.payload,
        sigHeader: input.signature,
        secret: this.#secret,
        tolerance: WORKOS_WEBHOOK_TOLERANCE_MS,
      });
    } catch {
      throw new WorkOSWebhookRejectedError();
    }

    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(input.payload) as unknown;
    } catch {
      throw new WorkOSWebhookRejectedError();
    }

    const transformedEnvelope = transformedEventEnvelopeSchema.safeParse(transformedEvent);
    const rawEnvelope = rawEventEnvelopeSchema.safeParse(rawEvent);
    if (
      !transformedEnvelope.success ||
      !rawEnvelope.success ||
      transformedEnvelope.data.id !== rawEnvelope.data.id ||
      transformedEnvelope.data.event !== rawEnvelope.data.event ||
      transformedEnvelope.data.createdAt !== rawEnvelope.data.created_at ||
      transformedEnvelope.data.context?.client_id !== this.#clientId ||
      rawEnvelope.data.context?.client_id !== this.#clientId
    ) {
      throw new WorkOSWebhookRejectedError();
    }
    if (transformedEnvelope.data.event !== "session.revoked") {
      return "ignored";
    }

    const event = transformedSessionRevokedEventSchema.safeParse(transformedEvent);
    const rawRevokedEvent = rawSessionRevokedEventSchema.safeParse(rawEvent);
    if (
      !event.success ||
      !rawRevokedEvent.success ||
      event.data.data.id !== rawRevokedEvent.data.data.id
    ) {
      throw new WorkOSWebhookRejectedError();
    }

    try {
      const processed = await this.#store.applyWorkOSSessionRevokedEvent({
        eventId: event.data.id,
        workosSessionId: event.data.data.id,
        occurredAt: new Date(event.data.createdAt),
        now: this.#now(),
      });
      return processed ? "processed" : "duplicate";
    } catch {
      throw new WorkOSWebhookUnavailableError();
    }
  }
}

export function createWorkOSWebhookProcessor(options: {
  readonly apiKey: string;
  readonly clientId: string;
  readonly webhookSecret: string;
  readonly store: WorkOSSessionRevokedEventStore;
}): WorkOSWebhookProcessor {
  const workos = new WorkOS(options.apiKey, { clientId: options.clientId });
  return new VerifiedWorkOSWebhookProcessor({
    verifier: {
      constructEvent: (input) => workos.webhooks.constructEvent(input),
    },
    clientId: options.clientId,
    secret: options.webhookSecret,
    store: options.store,
  });
}
