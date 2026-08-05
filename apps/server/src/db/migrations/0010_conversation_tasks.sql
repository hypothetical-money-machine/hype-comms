ALTER TABLE conversations
  ADD COLUMN last_task_number bigint NOT NULL DEFAULT 0
    CHECK (last_task_number >= 0);

ALTER TABLE messages
  ADD CONSTRAINT messages_id_conversation_unique UNIQUE (id, conversation_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  number bigint NOT NULL CHECK (number > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title text NOT NULL CHECK (
    char_length(title) BETWEEN 1 AND 240
    AND char_length(btrim(title)) > 0
  ),
  description text CHECK (char_length(description) <= 10000),
  status text NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
  priority text NOT NULL DEFAULT 'none'
    CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  assignee_id uuid,
  due_on date,
  source_message_id uuid,
  rank bigint NOT NULL CHECK (rank > 0),
  created_by uuid NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id),
  UNIQUE (conversation_id, number),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, assignee_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, conversation_id)
    REFERENCES messages(id, conversation_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'done' AND completed_at IS NOT NULL)
    OR (status <> 'done' AND completed_at IS NULL)
  )
);

CREATE INDEX tasks_conversation_board
  ON tasks (conversation_id, status, rank, id);
CREATE INDEX tasks_conversation_updated
  ON tasks (conversation_id, updated_at DESC, id DESC);
CREATE INDEX tasks_assignee_updated
  ON tasks (workspace_id, assignee_id, updated_at DESC, id DESC)
  WHERE assignee_id IS NOT NULL;

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
      'read_cursor.updated',
      'task.created',
      'task.updated'
    )
  );

ALTER TABLE realtime_tickets
  ADD COLUMN task_events boolean NOT NULL DEFAULT false;
