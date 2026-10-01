-- Existing workspaces remain inactive until the maintenance-window command records their floor.
-- This migration never rewrites historical events, mutation receipts, or authoritative entities.
ALTER TABLE workspaces
  ADD COLUMN protocol_epoch uuid,
  ADD COLUMN protocol_replay_floor bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT workspace_protocol_replay_floor_valid
    CHECK (protocol_replay_floor >= 0 AND protocol_replay_floor <= last_event_sequence),
  ADD CONSTRAINT workspace_protocol_inactive_floor_valid
    CHECK (protocol_epoch IS NOT NULL OR protocol_replay_floor = 0);

-- Workspaces created by the new server begin with an empty replay history.
ALTER TABLE workspaces ALTER COLUMN protocol_epoch SET DEFAULT gen_random_uuid();

-- Old tickets cannot acquire the newly established epoch by being consumed after cutover.
ALTER TABLE realtime_tickets ADD COLUMN protocol_epoch uuid;
