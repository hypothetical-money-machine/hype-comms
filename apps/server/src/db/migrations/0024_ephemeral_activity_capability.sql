-- The value freezes rolling-compatibility negotiation onto a one-time realtime ticket. Activity
-- itself is never stored: it exists only in the in-memory socket hub.
ALTER TABLE realtime_tickets
  ADD COLUMN ephemeral_activity boolean NOT NULL DEFAULT false;
