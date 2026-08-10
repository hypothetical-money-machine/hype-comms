ALTER TABLE conversations
  ADD COLUMN channel_mode text;

UPDATE conversations
   SET channel_mode = 'chat'
 WHERE kind = 'channel';

-- A column default would also affect direct conversations written by an older server. Normalize
-- only channel inserts so old and new writers can safely overlap during the rollout.
CREATE FUNCTION set_initial_channel_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'channel' AND NEW.channel_mode IS NULL THEN
    NEW.channel_mode := 'chat';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_set_initial_channel_mode
BEFORE INSERT ON conversations
FOR EACH ROW
EXECUTE FUNCTION set_initial_channel_mode();

ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_mode_valid CHECK (
    (
      kind = 'channel'
      AND channel_mode IS NOT NULL
      AND channel_mode IN ('chat', 'announcement')
    )
    OR (kind <> 'channel' AND channel_mode IS NULL)
  );

CREATE FUNCTION reject_channel_mode_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.channel_mode IS DISTINCT FROM NEW.channel_mode THEN
    RAISE EXCEPTION 'channel mode is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'conversations_channel_mode_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_reject_channel_mode_change
BEFORE UPDATE OF channel_mode ON conversations
FOR EACH ROW
EXECUTE FUNCTION reject_channel_mode_change();

ALTER TABLE realtime_tickets
  ADD COLUMN announcement_channels boolean NOT NULL DEFAULT false;

-- The per-process rollout setting may differ briefly while compatible nodes restart. Persist the
-- cutover once any node enables it so another node cannot later emit a legacy-shaped event or
-- hide announcement UI after announcement data can exist.
ALTER TABLE workspaces
  ADD COLUMN announcement_channels_available boolean NOT NULL DEFAULT false;

CREATE FUNCTION reject_announcement_channel_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM conversations
     WHERE id = NEW.conversation_id
       AND workspace_id = NEW.workspace_id
       AND channel_mode = 'announcement'
  ) THEN
    RAISE EXCEPTION 'tasks are not available in announcement channels'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_no_announcement_channel';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_reject_announcement_channel
BEFORE INSERT OR UPDATE OF conversation_id, workspace_id ON tasks
FOR EACH ROW
EXECUTE FUNCTION reject_announcement_channel_task();
