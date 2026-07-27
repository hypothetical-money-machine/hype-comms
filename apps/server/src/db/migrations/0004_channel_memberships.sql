ALTER TABLE conversations
  ADD COLUMN channel_access text;

UPDATE conversations
   SET channel_access = 'workspace'
 WHERE kind = 'channel';

ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_access CHECK (
    (kind = 'channel' AND channel_access IS NOT NULL
      AND channel_access IN ('workspace', 'members'))
    OR (kind = 'direct_message' AND channel_access IS NULL)
  );

CREATE TABLE conversation_memberships (
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX conversation_memberships_user_active
  ON conversation_memberships (workspace_id, user_id, conversation_id)
  WHERE left_at IS NULL;

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
      'read_cursor.updated'
    )
  );
