ALTER TABLE messages
  DROP CONSTRAINT messages_thread_root_id_check;

ALTER TABLE messages
  DROP CONSTRAINT messages_thread_root_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_id_conversation_id_unique UNIQUE (id, conversation_id);

ALTER TABLE messages
  ADD CONSTRAINT messages_thread_root_conversation_fkey
  FOREIGN KEY (thread_root_id, conversation_id)
  REFERENCES messages(id, conversation_id) ON DELETE RESTRICT;

ALTER TABLE messages
  ADD CONSTRAINT messages_thread_root_not_self
  CHECK (thread_root_id IS NULL OR thread_root_id <> id);

CREATE INDEX messages_root_history
  ON messages (conversation_id, conversation_sequence DESC, id DESC)
  WHERE thread_root_id IS NULL;

CREATE INDEX messages_thread_replies
  ON messages (thread_root_id, conversation_sequence DESC, id DESC)
  WHERE thread_root_id IS NOT NULL;

CREATE FUNCTION enforce_message_thread_depth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_thread_root_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id THEN
    RAISE EXCEPTION 'A message thread root cannot be changed after creation'
      USING ERRCODE = '23514',
            CONSTRAINT = 'messages_thread_root_immutable';
  END IF;

  IF NEW.thread_root_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT thread_root_id
    INTO parent_thread_root_id
    FROM messages
   WHERE id = NEW.thread_root_id;

  IF parent_thread_root_id IS NOT NULL THEN
    RAISE EXCEPTION 'A thread reply must reference a top-level message'
      USING ERRCODE = '23514',
            CONSTRAINT = 'messages_thread_root_must_be_top_level';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_enforce_thread_depth
BEFORE INSERT OR UPDATE OF thread_root_id, conversation_id
ON messages
FOR EACH ROW
EXECUTE FUNCTION enforce_message_thread_depth();
