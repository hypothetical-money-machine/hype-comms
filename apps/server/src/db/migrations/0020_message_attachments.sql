CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid,
  uploaded_by uuid NOT NULL,
  file_name text NOT NULL CHECK (
    char_length(btrim(file_name)) BETWEEN 1 AND 255
    AND file_name !~ '[\\/]'
    AND file_name !~ '[[:cntrl:]]'
  ),
  content_type text NOT NULL CHECK (
    char_length(btrim(content_type)) BETWEEN 3 AND 255
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  upload_expires_at timestamptz,
  content_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, uploaded_by)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND message_id IS NULL AND upload_expires_at IS NOT NULL)
    OR (status = 'ready' AND content_received_at IS NOT NULL)
    OR status = 'failed'
  ),
  CHECK (message_id IS NULL OR status = 'ready')
);

CREATE INDEX attachments_conversation_ready
  ON attachments (conversation_id, created_at DESC, id DESC)
  WHERE status = 'ready' AND message_id IS NOT NULL;

CREATE INDEX attachments_message
  ON attachments (message_id, created_at, id)
  WHERE message_id IS NOT NULL;
