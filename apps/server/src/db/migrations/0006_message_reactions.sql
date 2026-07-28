ALTER TABLE messages
  ADD CONSTRAINT messages_id_workspace_unique UNIQUE (id, workspace_id);

CREATE TABLE message_reactions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  emoji text NOT NULL CHECK (
    char_length(emoji) BETWEEN 1 AND 64
    AND octet_length(emoji) <= 256
    AND emoji = btrim(emoji)
    AND emoji = normalize(emoji, NFC)
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (message_id, user_id, emoji),
  FOREIGN KEY (message_id, workspace_id)
    REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX message_reactions_user
  ON message_reactions (workspace_id, user_id, message_id);

ALTER TABLE realtime_tickets
  ADD COLUMN reaction_events boolean NOT NULL DEFAULT false;

ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_event_type_check;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_event_type_check CHECK (
    event_type IN (
      'member.updated',
      'channel.created',
      'channel.archived',
      'channel.membership_changed',
      'direct_conversation.created',
      'message.created',
      'reaction.added',
      'reaction.removed',
      'read_cursor.updated'
    )
  );
