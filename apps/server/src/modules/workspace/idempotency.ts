import { createHash, timingSafeEqual } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";

interface IdempotencyRecordRow extends QueryResultRow {
  readonly request_fingerprint: Buffer;
  readonly response_status: number;
  readonly response_body: unknown;
}

interface ResponseSchema<Response> {
  parse(value: unknown): Response;
}

interface IdempotentMutationOptions<Response> {
  readonly actorUserId: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: Buffer;
  readonly responseStatus: number;
  readonly responseSchema: ResponseSchema<Response>;
  /** Use a broader scope when one operation key must remain unique across multiple routes. */
  readonly lockScope?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  throw new Error("Idempotency fingerprints support only JSON values");
}

function sameFingerprint(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function fingerprintApiRequest(value: unknown): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest();
}

export async function lockIdempotencyScope(client: PoolClient, scope: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
}

/**
 * Serialize one mutation key, replay its committed response, and persist a new response in the
 * caller's transaction. Keeping this at the database boundary makes concurrent retries safe even
 * when they reach different server processes.
 */
export async function runIdempotentMutation<Response>(
  client: PoolClient,
  options: IdempotentMutationOptions<Response>,
  operation: () => Promise<Response>,
): Promise<Response> {
  await lockIdempotencyScope(
    client,
    `${options.actorUserId}:${options.lockScope ?? `${options.route}:${options.idempotencyKey}`}`,
  );
  const existing = await client.query<IdempotencyRecordRow>(
    `SELECT request_fingerprint, response_status, response_body
       FROM api_idempotency_records
      WHERE actor_user_id = $1
        AND route = $2
        AND idempotency_key = $3`,
    [options.actorUserId, options.route, options.idempotencyKey],
  );
  const replay = existing.rows[0];
  if (replay !== undefined) {
    if (!sameFingerprint(replay.request_fingerprint, options.requestFingerprint)) {
      throw new ApiError(
        409,
        "CONFLICT",
        "The idempotency key was already used for another request",
      );
    }
    if (replay.response_status !== options.responseStatus) {
      throw new Error("Stored idempotency response status does not match the route");
    }
    return options.responseSchema.parse(replay.response_body);
  }

  const response = await operation();
  await client.query(
    `INSERT INTO api_idempotency_records
       (actor_user_id, route, idempotency_key, request_fingerprint, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      options.actorUserId,
      options.route,
      options.idempotencyKey,
      options.requestFingerprint,
      options.responseStatus,
      JSON.stringify(response),
    ],
  );
  return response;
}
