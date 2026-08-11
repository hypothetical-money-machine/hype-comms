CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'workos' CHECK (provider = 'workos'),
  provider_subject text NOT NULL CHECK (
    char_length(provider_subject) BETWEEN 1 AND 255
    AND provider_subject ~ '^user_[A-Za-z0-9]+$'
  ),
  user_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'human' CHECK (principal_kind = 'human'),
  last_verified_email public.citext NOT NULL CHECK (
    last_verified_email::text = lower(btrim(last_verified_email::text))
    AND char_length(last_verified_email::text) BETWEEN 3 AND 320
  ),
  last_authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id, principal_kind) REFERENCES users(id, kind) ON DELETE CASCADE,
  UNIQUE (provider, provider_subject),
  UNIQUE (provider, user_id)
);

CREATE TABLE authkit_transactions (
  id uuid PRIMARY KEY,
  provider_state_hash bytea NOT NULL UNIQUE CHECK (octet_length(provider_state_hash) = 32),
  verifier_nonce bytea,
  verifier_ciphertext bytea,
  verifier_authentication_tag bytea,
  desktop_code_challenge text NOT NULL CHECK (
    desktop_code_challenge ~ '^[A-Za-z0-9_-]{43}$'
  ),
  desktop_state text NOT NULL CHECK (desktop_state ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (
      consumed_at IS NULL
      AND verifier_nonce IS NOT NULL
      AND octet_length(verifier_nonce) = 12
      AND verifier_ciphertext IS NOT NULL
      AND octet_length(verifier_ciphertext) BETWEEN 43 AND 128
      AND verifier_authentication_tag IS NOT NULL
      AND octet_length(verifier_authentication_tag) = 16
    )
    OR (
      consumed_at IS NOT NULL
      AND verifier_nonce IS NULL
      AND verifier_ciphertext IS NULL
      AND verifier_authentication_tag IS NULL
    )
  )
);

CREATE INDEX authkit_transactions_expires_at_idx ON authkit_transactions (expires_at);

CREATE TABLE authkit_handoffs (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  principal_kind text NOT NULL DEFAULT 'human' CHECK (principal_kind = 'human'),
  desktop_code_challenge text NOT NULL CHECK (
    desktop_code_challenge ~ '^[A-Za-z0-9_-]{43}$'
  ),
  workos_session_id text NOT NULL CHECK (
    char_length(workos_session_id) BETWEEN 1 AND 255
    AND workos_session_id ~ '^session_[A-Za-z0-9]+$'
  ),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, principal_kind) REFERENCES users(id, kind) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX authkit_handoffs_expires_at_idx ON authkit_handoffs (expires_at);

ALTER TABLE device_sessions
  ADD COLUMN workos_session_id text CHECK (
    workos_session_id IS NULL
    OR (
      char_length(workos_session_id) BETWEEN 1 AND 255
      AND workos_session_id ~ '^session_[A-Za-z0-9]+$'
    )
  );

CREATE INDEX device_sessions_active_workos_session_idx
  ON device_sessions (workos_session_id)
  WHERE workos_session_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE workos_events (
  event_id text PRIMARY KEY CHECK (
    char_length(event_id) BETWEEN 1 AND 255
    AND event_id ~ '^event_[A-Za-z0-9]+$'
  ),
  event_type text NOT NULL CHECK (event_type = 'session.revoked'),
  workos_session_id text NOT NULL CHECK (
    char_length(workos_session_id) BETWEEN 1 AND 255
    AND workos_session_id ~ '^session_[A-Za-z0-9]+$'
  ),
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX workos_events_processed_at_idx ON workos_events (processed_at);
CREATE INDEX workos_events_session_idx ON workos_events (workos_session_id);
