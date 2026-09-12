import { sequenceSchema, syncPositionSchema, type SyncPosition } from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { DomainError } from "../../domain-errors.js";
import { runWorkspaceTransaction } from "./transaction.js";

export interface WorkspaceProtocolState {
  readonly epoch: string;
  readonly sequence: string;
  readonly replayFloor: string;
}

interface ProtocolRow extends QueryResultRow {
  readonly protocol_epoch: string | null;
  readonly protocol_replay_floor: string;
  readonly last_event_sequence: string;
}

export async function inspectWorkspaceProtocol(
  client: PoolClient,
  workspaceId: string,
): Promise<Omit<WorkspaceProtocolState, "epoch"> & { readonly epoch: string | null }> {
  const result = await client.query<ProtocolRow>(
    `SELECT protocol_epoch, protocol_replay_floor::text, last_event_sequence::text
       FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DomainError("not_found", "Workspace not found");
  return {
    epoch: row.protocol_epoch,
    sequence: row.last_event_sequence,
    replayFloor: row.protocol_replay_floor,
  };
}

export async function readWorkspaceProtocol(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceProtocolState> {
  const state = await inspectWorkspaceProtocol(client, workspaceId);
  if (state.epoch === null)
    throw new DomainError("unavailable", "Workspace protocol cutover has not completed");
  return { ...state, epoch: state.epoch };
}

/** A retained mutation can predate this epoch; its receipt must never resume below the new floor. */
export async function positionForRetainedSequence(
  client: PoolClient,
  workspaceId: string,
  sequence: string,
): Promise<SyncPosition> {
  sequenceSchema.parse(sequence);
  const protocol = await readWorkspaceProtocol(client, workspaceId);
  if (BigInt(sequence) > BigInt(protocol.sequence)) {
    throw new DomainError(
      "integrity_failure",
      "Stored mutation position exceeds workspace history",
    );
  }
  return {
    epoch: protocol.epoch,
    sequence: BigInt(sequence) < BigInt(protocol.replayFloor) ? protocol.replayFloor : sequence,
  };
}

/**
 * Run only during the coordinated maintenance window with all product writers stopped.
 * The recorded expected state prevents a stale operator read from hiding intervening messages.
 * Reusing the same epoch and floor is restartable; it never moves the floor on a second run.
 */
export async function establishWorkspaceProtocolEpoch(
  pool: Pool,
  input: {
    readonly workspaceId: string;
    readonly expectedEpoch: string | null;
    readonly expectedSequence: string;
    readonly epoch: string;
  },
): Promise<WorkspaceProtocolState> {
  syncPositionSchema.parse({ epoch: input.epoch, sequence: input.expectedSequence });
  return runWorkspaceTransaction(pool, async (client) => {
    const result = await client.query<ProtocolRow>(
      `SELECT protocol_epoch, protocol_replay_floor::text, last_event_sequence::text
         FROM workspaces WHERE id = $1 FOR UPDATE`,
      [input.workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new DomainError("not_found", "Workspace not found");
    if (row.protocol_epoch === input.epoch) {
      if (row.protocol_replay_floor !== input.expectedSequence) {
        throw new DomainError("conflict", "This epoch was established at a different replay floor");
      }
      return {
        epoch: input.epoch,
        sequence: row.last_event_sequence,
        replayFloor: input.expectedSequence,
      };
    }
    if (
      row.protocol_epoch !== input.expectedEpoch ||
      row.last_event_sequence !== input.expectedSequence
    ) {
      throw new DomainError(
        "conflict",
        "Workspace changed after the cutover position was recorded",
      );
    }
    await client.query(
      `UPDATE workspaces SET protocol_epoch = $2, protocol_replay_floor = $3::bigint WHERE id = $1`,
      [input.workspaceId, input.epoch, input.expectedSequence],
    );
    return {
      epoch: input.epoch,
      sequence: row.last_event_sequence,
      replayFloor: input.expectedSequence,
    };
  });
}
