ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'human'
    CHECK (kind IN ('human', 'bot'));

ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_identity_shape CHECK (
    (kind = 'human' AND email IS NOT NULL)
    OR (kind = 'bot' AND email IS NULL)
  ),
  ADD CONSTRAINT users_id_kind_unique UNIQUE (id, kind);

CREATE TABLE bot_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  bot_user_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'bot' CHECK (principal_kind = 'bot'),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND scopes <@ ARRAY['tasks:read', 'tasks:write']::text[]
  ),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (bot_user_id, principal_kind)
    REFERENCES users(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, bot_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE INDEX bot_credentials_bot_created
  ON bot_credentials (workspace_id, bot_user_id, created_at DESC);
CREATE INDEX bot_credentials_expiry
  ON bot_credentials (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE bot_channel_grants (
  workspace_id uuid NOT NULL,
  bot_user_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'bot' CHECK (principal_kind = 'bot'),
  conversation_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bot_user_id, conversation_id),
  FOREIGN KEY (bot_user_id, principal_kind)
    REFERENCES users(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, bot_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, granted_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX bot_channel_grants_conversation
  ON bot_channel_grants (conversation_id, bot_user_id);
