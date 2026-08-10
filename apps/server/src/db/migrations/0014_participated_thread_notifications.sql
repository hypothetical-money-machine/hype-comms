-- Keep participated-thread eligibility out of the shared event JSON. The reason belongs to one
-- authorized recipient, and its audience foreign key makes that intersection durable at commit.
CREATE TABLE sync_event_notification_reasons (
  event_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason = 'participated_thread_reply'),
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id, workspace_id)
    REFERENCES sync_events(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, user_id)
    REFERENCES sync_event_audiences(event_id, user_id) ON DELETE CASCADE
);

ALTER TABLE realtime_tickets
  ADD COLUMN participated_thread_notifications boolean NOT NULL DEFAULT false;
