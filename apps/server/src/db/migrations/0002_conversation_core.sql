ALTER TABLE workspaces
  ADD COLUMN last_event_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_event_sequence >= 0);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('channel', 'direct_message')),
  name text,
  slug text,
  topic text,
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid,
  dm_user_low_id uuid,
  dm_user_high_id uuid,
  last_message_sequence bigint NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, dm_user_low_id, dm_user_high_id),
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, dm_user_low_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, dm_user_high_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (
      kind = 'channel'
      AND name IS NOT NULL
      AND char_length(btrim(name)) BETWEEN 1 AND 100
      AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND dm_user_low_id IS NULL
      AND dm_user_high_id IS NULL
    )
    OR
    (
      kind = 'direct_message'
      AND name IS NULL
      AND slug IS NULL
      AND topic IS NULL
      AND dm_user_low_id IS NOT NULL
      AND dm_user_high_id IS NOT NULL
      AND dm_user_low_id::text < dm_user_high_id::text
      AND dm_user_low_id <> dm_user_high_id
      AND NOT is_archived
    )
  ),
  CHECK (topic IS NULL OR char_length(btrim(topic)) <= 250),
  CHECK (slug <> 'general' OR (kind = 'channel' AND NOT is_archived))
);

CREATE INDEX conversations_workspace_kind
  ON conversations (workspace_id, kind, created_at, id);
CREATE INDEX conversations_dm_low
  ON conversations (workspace_id, dm_user_low_id)
  WHERE kind = 'direct_message';
CREATE INDEX conversations_dm_high
  ON conversations (workspace_id, dm_user_high_id)
  WHERE kind = 'direct_message';

INSERT INTO conversations (
  id,
  workspace_id,
  kind,
  name,
  slug,
  topic,
  created_by
)
SELECT
  gen_random_uuid(),
  workspace.id,
  'channel',
  'General',
  'general',
  'Workspace-wide conversation',
  workspace.created_by
FROM workspaces AS workspace
ON CONFLICT (workspace_id, slug) DO NOTHING;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  conversation_sequence bigint NOT NULL CHECK (conversation_sequence > 0),
  committed_workspace_sequence bigint NOT NULL CHECK (committed_workspace_sequence > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_message_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  author_id uuid NOT NULL,
  thread_root_id uuid,
  body text NOT NULL CHECK (
    char_length(body) BETWEEN 1 AND 4000
    AND char_length(btrim(body)) > 0
  ),
  body_format text NOT NULL CHECK (body_format = 'hmm_markdown_v1'),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, conversation_sequence),
  UNIQUE (author_id, client_message_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, author_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_root_id) REFERENCES messages(id) ON DELETE RESTRICT,
  CHECK (thread_root_id IS NULL),
  CHECK (edited_at IS NULL AND deleted_at IS NULL)
);

CREATE INDEX messages_history
  ON messages (conversation_id, conversation_sequence DESC, id DESC);

CREATE TABLE message_mentions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (message_id, mentioned_user_id)
);

CREATE INDEX message_mentions_user
  ON message_mentions (mentioned_user_id, message_id);

CREATE TABLE conversation_read_cursors (
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_message_id uuid,
  last_read_conversation_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_read_conversation_sequence >= 0),
  last_read_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE RESTRICT
);

CREATE TABLE sync_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_sequence bigint NOT NULL CHECK (workspace_sequence > 0),
  conversation_id uuid,
  conversation_sequence bigint,
  event_type text NOT NULL CHECK (
    event_type IN (
      'member.updated',
      'channel.created',
      'channel.archived',
      'direct_conversation.created',
      'message.created',
      'read_cursor.updated'
    )
  ),
  actor_user_id uuid,
  entity_version integer NOT NULL DEFAULT 1 CHECK (entity_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, workspace_sequence),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (conversation_sequence IS NULL OR conversation_sequence > 0)
);

CREATE INDEX sync_events_retention ON sync_events (created_at);

CREATE TABLE sync_event_audiences (
  event_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id, workspace_id)
    REFERENCES sync_events(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX sync_event_audiences_user
  ON sync_event_audiences (workspace_id, user_id, event_id);

CREATE TABLE api_idempotency_records (
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  route text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 255),
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  response_status smallint NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, route, idempotency_key)
);

CREATE TABLE realtime_tickets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_session_id uuid NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX realtime_tickets_expiry ON realtime_tickets (expires_at);
