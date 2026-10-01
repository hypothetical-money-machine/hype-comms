-- Built-in ("system") channels are owned by the server rather than by a member. They live in the
-- reserved `hype/` slug namespace, which no member can reach: the client and contract slug grammar
-- has no `/`, so `UNIQUE (workspace_id, slug)` can never collide between the two namespaces.
--
-- They are announcement channels, so the existing announcement protections apply unchanged: tasks
-- are rejected by trigger, bot grants and channel webhooks are refused, and only the seeder writes
-- root messages. Members still reply in threads and react.
--
-- Like announcement_channels_available, the workspace cutover below is one-way. Enable
-- HYPE_COMMS_SYSTEM_CHANNELS_ENABLED only once every node runs this release: a node from the
-- previous release cannot parse a `hype/` slug and would fail any read that touches a seeded row.
ALTER TABLE conversations
  ADD COLUMN is_system boolean NOT NULL DEFAULT false;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_system_valid CHECK (
    (
      is_system
      AND kind = 'channel'
      AND slug LIKE 'hype/%'
      AND channel_mode = 'announcement'
      AND channel_access = 'workspace'
      AND NOT human_only
      AND NOT is_archived
    )
    OR (NOT is_system AND (slug IS NULL OR slug NOT LIKE 'hype/%'))
  );

-- A member-facing channel can never become server-owned, and a built-in channel can never be
-- renamed out of the reserved namespace, even if a future code path forgets to exclude it.
CREATE FUNCTION reject_system_channel_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_system IS DISTINCT FROM NEW.is_system
     OR (OLD.is_system AND OLD.slug IS DISTINCT FROM NEW.slug) THEN
    RAISE EXCEPTION 'built-in channel identity is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_system_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_reject_system_change
BEFORE UPDATE OF is_system, slug ON conversations
FOR EACH ROW
EXECUTE FUNCTION reject_system_channel_change();

ALTER TABLE realtime_tickets
  ADD COLUMN system_channels boolean NOT NULL DEFAULT false;

-- Operators enable seeding only after every server and realtime worker understands the namespace.
-- Once one upgraded node enables a workspace, all upgraded nodes keep serving its built-in
-- channels.
ALTER TABLE workspaces
  ADD COLUMN system_channels_available boolean NOT NULL DEFAULT false;

-- The auditable publisher for server-authored bulletins. A bot principal keeps it out of the
-- human-owner authorization paths; the fixed id lets the seeder reference it without a lookup, and
-- a username collision fails this migration loudly rather than at first seed.
INSERT INTO users (id, email, kind, username, display_name, avatar_url)
VALUES ('a0000000-0000-4000-8000-00000000c001', NULL, 'bot', 'hype-comms-system', 'Hype Comms', NULL);

-- One row per delivered bulletin. The primary key is the idempotency claim that keeps restarts and
-- concurrent nodes from posting a release note twice.
CREATE TABLE system_bulletins (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_slug text NOT NULL CHECK (channel_slug LIKE 'hype/%'),
  bulletin_key text NOT NULL CHECK (char_length(bulletin_key) BETWEEN 1 AND 100),
  message_id uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, channel_slug, bulletin_key)
);
