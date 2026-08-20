-- Authors may retract their own message within five minutes. The original table
-- forbade any deleted_at/edited_at write; replace that immutability check with
-- a retract-only contract: edits stay forbidden, a retracted body must be empty,
-- and the row stays in place as a tombstone.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'messages'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) IN (
         'CHECK ((edited_at IS NULL AND deleted_at IS NULL))',
         'CHECK ((edited_at IS NULL))'
       )
  LOOP
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

ALTER TABLE messages
  DROP CONSTRAINT messages_body_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_edited_at_forbidden
  CHECK (edited_at IS NULL);

ALTER TABLE messages
  ADD CONSTRAINT messages_body_check
  CHECK (
    (
      deleted_at IS NULL
      AND char_length(body) BETWEEN 1 AND 4000
      AND char_length(btrim(body)) > 0
    )
    OR
    (
      deleted_at IS NOT NULL
      AND body = ''
    )
  );

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
