-- Epic 3 is expand-only: existing explicitly scoped credentials remain unchanged while every
-- workspace receives a fail-closed enrollment policy and new enrollment rows carry their pinned
-- default-agency-v1 profile.
ALTER TABLE workspaces
  ADD COLUMN agent_enrollment_policy text NOT NULL DEFAULT 'required'
    CHECK (agent_enrollment_policy IN ('required', 'automatic')),
  ADD COLUMN agent_enrollment_policy_updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION valid_agent_scopes(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(candidate) BETWEEN 1 AND 6
    AND candidate <@ ARRAY[
      'workspace:read',
      'messages:write',
      'conversations:write',
      'read-cursors:write',
      'direct-conversations:write',
      'agents:invite'
    ]::text[]
    AND cardinality(candidate) = (
      SELECT count(DISTINCT scope_name)::integer
      FROM unnest(candidate) AS scope_name
    )
$$;

CREATE TABLE agent_enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  profile text NOT NULL CHECK (profile = 'default-agency-v1'),
  status text NOT NULL CHECK (status IN (
    'pending_approval',
    'ready_to_redeem',
    'active',
    'rejected',
    'cancelled',
    'expired'
  )),
  username text NOT NULL CHECK (username ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  token_label text NOT NULL CHECK (char_length(btrim(token_label)) BETWEEN 1 AND 120),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('human', 'agent')),
  requested_by_agent_token_id uuid REFERENCES agent_tokens(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  credential_verifier bytea NOT NULL UNIQUE CHECK (octet_length(credential_verifier) = 32),
  expires_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  activated_agent_user_id uuid,
  activated_agent_token_id uuid REFERENCES agent_tokens(id) ON DELETE RESTRICT,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  UNIQUE (requested_by, idempotency_key),
  FOREIGN KEY (workspace_id, requested_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, activated_agent_user_id)
    REFERENCES agents(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (requested_by_kind = 'agent' AND requested_by_agent_token_id IS NOT NULL)
    OR (requested_by_kind = 'human' AND requested_by_agent_token_id IS NULL)
  ),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (
    (
      status = 'active'
      AND activated_agent_user_id IS NOT NULL
      AND activated_agent_token_id IS NOT NULL
      AND activated_at IS NOT NULL
    )
    OR (
      status <> 'active'
      AND activated_agent_user_id IS NULL
      AND activated_agent_token_id IS NULL
      AND activated_at IS NULL
    )
  ),
  CHECK (expires_at > created_at)
);

CREATE INDEX agent_enrollments_workspace_created
  ON agent_enrollments (workspace_id, created_at DESC, id DESC);

CREATE INDEX agent_enrollments_requester_created
  ON agent_enrollments (workspace_id, requested_by, created_at DESC, id DESC);

CREATE INDEX agent_enrollments_expiry
  ON agent_enrollments (expires_at)
  WHERE status IN ('pending_approval', 'ready_to_redeem');

CREATE TABLE agent_enrollment_restricted_channels (
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  PRIMARY KEY (enrollment_id, conversation_id),
  FOREIGN KEY (enrollment_id, workspace_id)
    REFERENCES agent_enrollments(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE agent_enrollment_transitions (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN (
    'pending_approval',
    'ready_to_redeem',
    'active',
    'rejected',
    'cancelled',
    'expired'
  )),
  to_status text NOT NULL CHECK (to_status IN (
    'pending_approval',
    'ready_to_redeem',
    'active',
    'rejected',
    'cancelled',
    'expired'
  )),
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 120),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (enrollment_id, workspace_id)
    REFERENCES agent_enrollments(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX agent_enrollment_transitions_enrollment
  ON agent_enrollment_transitions (enrollment_id, occurred_at, id);

CREATE TABLE agent_enrollment_policy_transitions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  from_mode text NOT NULL CHECK (from_mode IN ('required', 'automatic')),
  to_mode text NOT NULL CHECK (to_mode IN ('required', 'automatic')),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_mode <> to_mode)
);

CREATE INDEX agent_enrollment_policy_transitions_workspace
  ON agent_enrollment_policy_transitions (workspace_id, occurred_at, id);

CREATE FUNCTION reject_agent_enrollment_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.workspace_id,
    NEW.profile,
    NEW.username,
    NEW.display_name,
    NEW.token_label,
    NEW.requested_by,
    NEW.requested_by_kind,
    NEW.requested_by_agent_token_id,
    NEW.idempotency_key,
    NEW.request_fingerprint,
    NEW.credential_verifier,
    NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id,
    OLD.profile,
    OLD.username,
    OLD.display_name,
    OLD.token_label,
    OLD.requested_by,
    OLD.requested_by_kind,
    OLD.requested_by_agent_token_id,
    OLD.idempotency_key,
    OLD.request_fingerprint,
    OLD.credential_verifier,
    OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'agent enrollment request fields are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_enrollments_request_immutable
BEFORE UPDATE ON agent_enrollments
FOR EACH ROW
EXECUTE FUNCTION reject_agent_enrollment_request_change();
