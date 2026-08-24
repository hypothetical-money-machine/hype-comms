ALTER TABLE conversations
  DROP CONSTRAINT conversations_kind_check,
  ADD CONSTRAINT conversations_kind_check
    CHECK (kind IN ('channel', 'direct_message', 'group_direct_message'));

-- Bind group support to realtime tickets so an older desktop receives a compatible projection
-- for the lifetime of its socket, including groups created after the socket connects.
ALTER TABLE realtime_tickets
  ADD COLUMN group_direct_messages boolean NOT NULL DEFAULT false;

ALTER TABLE conversations
  DROP CONSTRAINT conversations_check,
  ADD CONSTRAINT conversations_check CHECK (
    (
      kind = 'channel'
      AND name IS NOT NULL
      AND char_length(btrim(name)) BETWEEN 1 AND 100
      AND slug IS NOT NULL
      AND slug = normalize(slug, NFKC)
      AND slug = lower(slug)
      AND char_length(slug) BETWEEN 1 AND 100
      AND slug !~ '(^-|-$|--)'
      AND dm_user_low_id IS NULL
      AND dm_user_high_id IS NULL
    )
    OR
    (
      kind = 'direct_message'
      AND name IS NULL
      AND slug IS NULL
      AND topic IS NULL
      AND dm_user_low_id IS NOT NULL
      AND dm_user_high_id IS NOT NULL
      AND dm_user_low_id::text <= dm_user_high_id::text
      AND NOT is_archived
    )
    OR
    (
      kind = 'group_direct_message'
      AND name IS NULL
      AND slug IS NULL
      AND topic IS NULL
      AND dm_user_low_id IS NULL
      AND dm_user_high_id IS NULL
      AND NOT is_archived
    )
  );

ALTER TABLE conversations
  DROP CONSTRAINT conversations_channel_access,
  ADD CONSTRAINT conversations_channel_access CHECK (
    (kind = 'channel' AND channel_access IS NOT NULL
      AND channel_access IN ('workspace', 'members'))
    OR (kind IN ('direct_message', 'group_direct_message') AND channel_access IS NULL)
  );

-- Group membership is assembled in the same transaction as the conversation, then sealed. A
-- deferred validator permits that multi-statement creation while making PostgreSQL reject any
-- committed group that is malformed or left unlocked.
ALTER TABLE conversations
  ADD COLUMN group_memberships_locked boolean NOT NULL DEFAULT false;

CREATE FUNCTION validate_group_direct_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation_id uuid;
  old_conversation_id uuid;
  new_conversation_id uuid;
  target_conversation conversations%ROWTYPE;
  participant_count integer;
  active_participant_count integer;
  owner_count integer;
  invalid_participant_count integer;
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    new_conversation_id := NEW.id;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      old_conversation_id := OLD.conversation_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_conversation_id := NEW.conversation_id;
    END IF;
  END IF;

  FOREACH target_conversation_id IN ARRAY ARRAY[old_conversation_id, new_conversation_id]
  LOOP
    IF target_conversation_id IS NULL THEN
      CONTINUE;
    END IF;
    SELECT *
      INTO target_conversation
      FROM conversations
     WHERE id = target_conversation_id;
    IF NOT FOUND THEN
      -- The parent was deleted and its membership rows are being removed by ON DELETE CASCADE.
      CONTINUE;
    END IF;

    IF target_conversation.kind <> 'group_direct_message' THEN
      IF target_conversation.group_memberships_locked THEN
        RAISE EXCEPTION 'only group direct conversations may lock group membership'
          USING ERRCODE = 'check_violation';
      END IF;
      CONTINUE;
    END IF;

    IF NOT target_conversation.group_memberships_locked THEN
      RAISE EXCEPTION 'group direct conversation membership must be sealed before commit'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*)::integer,
           count(*) FILTER (WHERE membership.left_at IS NULL)::integer,
           count(*) FILTER (WHERE membership.role = 'owner')::integer,
           count(*) FILTER (
             WHERE user_account.kind NOT IN ('human', 'agent')
                OR workspace_membership.status <> 'active'
           )::integer
      INTO participant_count,
           active_participant_count,
           owner_count,
           invalid_participant_count
      FROM conversation_memberships AS membership
      JOIN users AS user_account ON user_account.id = membership.user_id
      JOIN workspace_memberships AS workspace_membership
        ON workspace_membership.workspace_id = membership.workspace_id
       AND workspace_membership.user_id = membership.user_id
     WHERE membership.conversation_id = target_conversation_id;

    IF participant_count NOT BETWEEN 3 AND 25
       OR active_participant_count <> participant_count
       OR owner_count <> 1
       OR invalid_participant_count <> 0
       OR NOT EXISTS (
         SELECT 1
           FROM conversation_memberships AS creator_membership
          WHERE creator_membership.conversation_id = target_conversation_id
            AND creator_membership.user_id = target_conversation.created_by
            AND creator_membership.role = 'owner'
            AND creator_membership.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'group direct conversation requires 3-25 fixed active human or agent participants and one creator-owner'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION protect_group_direct_membership_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind = 'group_direct_message'
     AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'group direct conversation kind is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind <> 'group_direct_message'
     AND NEW.kind = 'group_direct_message' THEN
    RAISE EXCEPTION 'an existing conversation cannot become a group direct conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.group_memberships_locked AND NOT NEW.group_memberships_locked THEN
    RAISE EXCEPTION 'group direct conversation membership seal is irreversible'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'group_direct_message'
     AND OLD.group_memberships_locked
     AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'group direct conversation creator is immutable after membership is sealed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_protect_group_membership_seal
BEFORE UPDATE OF kind, group_memberships_locked, created_by ON conversations
FOR EACH ROW
EXECUTE FUNCTION protect_group_direct_membership_seal();

CREATE FUNCTION reject_locked_group_direct_membership_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_conversation_id uuid;
  new_conversation_id uuid;
  membership_is_locked boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_conversation_id := OLD.conversation_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_conversation_id := NEW.conversation_id;
  END IF;
  SELECT coalesce(bool_or(conversation.group_memberships_locked), false)
    INTO membership_is_locked
    FROM conversations AS conversation
   WHERE conversation.id IN (old_conversation_id, new_conversation_id)
     AND conversation.kind = 'group_direct_message';
  IF membership_is_locked THEN
    RAISE EXCEPTION 'group direct conversation membership is fixed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversation_memberships_reject_locked_group_change
BEFORE INSERT OR UPDATE OR DELETE ON conversation_memberships
FOR EACH ROW
EXECUTE FUNCTION reject_locked_group_direct_membership_change();

CREATE CONSTRAINT TRIGGER conversations_validate_group_membership_insert
AFTER INSERT ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_group_direct_membership();

CREATE CONSTRAINT TRIGGER conversations_validate_group_membership_update
AFTER UPDATE ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.kind IS DISTINCT FROM NEW.kind
  OR OLD.group_memberships_locked IS DISTINCT FROM NEW.group_memberships_locked
  OR OLD.created_by IS DISTINCT FROM NEW.created_by
)
EXECUTE FUNCTION validate_group_direct_membership();

CREATE CONSTRAINT TRIGGER conversation_memberships_validate_group
AFTER INSERT OR UPDATE OR DELETE ON conversation_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_group_direct_membership();
