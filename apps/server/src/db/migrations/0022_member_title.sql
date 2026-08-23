-- Expand-only profile metadata. Application validation owns the display policy; NULL is the
-- intentional legacy/default state and no backfill is required.
ALTER TABLE users
  ADD COLUMN title text;

ALTER TABLE realtime_tickets
  ADD COLUMN member_profiles boolean NOT NULL DEFAULT false;
