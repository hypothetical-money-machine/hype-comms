-- Agent identities extend the human/bot discriminator introduced by 0011_bot_task_principals.
ALTER TABLE users
  DROP CONSTRAINT users_kind_check,
  DROP CONSTRAINT users_identity_shape,
  ADD CONSTRAINT users_kind_check CHECK (kind IN ('human', 'bot', 'agent')),
  ADD CONSTRAINT users_identity_shape CHECK (
    (kind = 'human' AND email IS NOT NULL)
    OR (kind IN ('bot', 'agent') AND email IS NULL)
  ),
  ADD CONSTRAINT users_agent_username_format CHECK (
    kind <> 'agent'
    OR username ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'
  );

CREATE TABLE agents (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  UNIQUE (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX agents_workspace_created
  ON agents (workspace_id, created_at, user_id);

CREATE FUNCTION validate_agent_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM users AS user_account
      JOIN workspace_memberships AS membership
        ON membership.user_id = user_account.id
       AND membership.workspace_id = NEW.workspace_id
     WHERE user_account.id = NEW.user_id
       AND user_account.kind = 'agent'
       AND user_account.email IS NULL
       AND membership.role = 'member'
       AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'agent identity requires an active member account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agents_identity_shape
BEFORE INSERT OR UPDATE OF user_id, workspace_id ON agents
FOR EACH ROW
EXECUTE FUNCTION validate_agent_identity();

CREATE FUNCTION valid_agent_scopes(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(candidate) BETWEEN 1 AND 4
    AND candidate <@ ARRAY[
      'workspace:read',
      'messages:write',
      'conversations:write',
      'read-cursors:write'
    ]::text[]
    AND cardinality(candidate) = (
      SELECT count(DISTINCT scope_name)::integer
      FROM unnest(candidate) AS scope_name
    )
$$;

CREATE TABLE agent_tokens (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  agent_user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  scopes text[] NOT NULL CHECK (valid_agent_scopes(scopes)),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, agent_user_id)
    REFERENCES agents(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, created_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX agent_tokens_agent_created
  ON agent_tokens (workspace_id, agent_user_id, created_at, id);

CREATE FUNCTION reject_agent_token_scope_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN
    RAISE EXCEPTION 'agent token scopes are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_tokens_scopes_immutable
BEFORE UPDATE OF scopes ON agent_tokens
FOR EACH ROW
EXECUTE FUNCTION reject_agent_token_scope_change();

ALTER TABLE realtime_tickets
  ALTER COLUMN device_session_id DROP NOT NULL,
  ADD COLUMN agent_token_id uuid REFERENCES agent_tokens(id) ON DELETE CASCADE,
  ADD CONSTRAINT realtime_tickets_one_credential CHECK (
    num_nonnulls(device_session_id, agent_token_id) = 1
  );

CREATE INDEX realtime_tickets_agent_token
  ON realtime_tickets (agent_token_id)
  WHERE agent_token_id IS NOT NULL;
