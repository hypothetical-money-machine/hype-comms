CREATE TABLE device_session_token_history (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  device_session_id uuid NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  rotation_xid xid8 NOT NULL,
  rotated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX device_session_token_history_expires_at_idx
  ON device_session_token_history (expires_at);

CREATE FUNCTION record_device_session_token_rotation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO device_session_token_history
    (token_hash, device_session_id, rotation_xid, rotated_at, expires_at)
  VALUES
    (OLD.token_hash, OLD.id, pg_current_xact_id(), NEW.last_seen_at, OLD.expires_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_sessions_record_token_rotation
AFTER UPDATE OF token_hash ON device_sessions
FOR EACH ROW
WHEN (OLD.token_hash IS DISTINCT FROM NEW.token_hash)
EXECUTE FUNCTION record_device_session_token_rotation();
