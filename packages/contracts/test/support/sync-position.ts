import type { SyncPosition } from "../../src/sync-position.js";

export const TEST_PROTOCOL_EPOCH = "eeeeeeee-0000-4000-8000-000000000001";

export function testPosition(sequence: string, epoch = TEST_PROTOCOL_EPOCH): SyncPosition {
  return { epoch, sequence };
}
