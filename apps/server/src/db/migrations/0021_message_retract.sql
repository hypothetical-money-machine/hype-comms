-- Scaffolding for a later delete-in-window retract. The original table forbade any
-- deleted_at/edited_at write (`messages_check`). Lift deleted_at only so a later
-- retract can tombstone the row in place. edited_at stays forbidden — this is not
-- editing. Do not relax the body CHECK: messageBodySchema still requires a
-- non-blank body, and emptying the body is not the retract.

ALTER TABLE messages
  DROP CONSTRAINT messages_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_edited_at_forbidden
  CHECK (edited_at IS NULL);

ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_event_type_check;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_event_type_check CHECK (
    event_type IN (
      'member.updated',
      'channel.created',
      'channel.archived',
      'channel.membership_changed',
      'direct_conversation.created',
      'message.created',
      'message.retracted',
      'reaction.added',
      'reaction.removed',
      'read_cursor.updated',
      'task.created',
      'task.updated'
    )
  );

ALTER TABLE realtime_tickets
  ADD COLUMN message_retract_events boolean NOT NULL DEFAULT false;
