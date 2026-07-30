ALTER TABLE realtime_tickets
  ADD COLUMN read_state_events boolean NOT NULL DEFAULT false;
