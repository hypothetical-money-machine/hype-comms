ALTER TABLE bot_credentials
  DROP CONSTRAINT bot_credentials_scopes_check,
  ADD CONSTRAINT bot_credentials_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 3
    AND scopes <@ ARRAY['messages:write', 'tasks:read', 'tasks:write']::text[]
  ),
  ADD CONSTRAINT bot_credentials_identity_unique
    UNIQUE (id, workspace_id, bot_user_id);

CREATE TABLE channel_webhooks (
  conversation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  bot_user_id uuid NOT NULL UNIQUE,
  current_credential_id uuid,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, bot_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (bot_user_id, conversation_id)
    REFERENCES bot_channel_grants(bot_user_id, conversation_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_credential_id, workspace_id, bot_user_id)
    REFERENCES bot_credentials(id, workspace_id, bot_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (current_credential_id IS NOT NULL AND disabled_at IS NULL)
    OR (current_credential_id IS NULL AND disabled_at IS NOT NULL)
  )
);

CREATE INDEX channel_webhooks_current_credential
  ON channel_webhooks (current_credential_id)
  WHERE current_credential_id IS NOT NULL;
