CREATE INDEX attachments_pending_upload_expiry
  ON attachments (upload_expires_at, id)
  WHERE status = 'pending';

CREATE INDEX attachments_unclaimed_ready_expiry
  ON attachments (content_received_at, id)
  WHERE status = 'ready' AND message_id IS NULL;
