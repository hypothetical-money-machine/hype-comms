-- Humans-only channels use the existing restricted-channel storage shape so servers from the
-- previous release cannot disclose them through the public-channel directory. The marker lets
-- capable servers project the distinct access mode, while database triggers maintain a seat for
-- every active human and reject non-human access even when an older server is still running.
ALTER TABLE conversations
  ADD COLUMN human_only boolean NOT NULL DEFAULT false;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_human_only_valid CHECK (
    (kind = 'channel' AND (NOT human_only OR channel_access = 'members'))
    OR (kind <> 'channel' AND NOT human_only)
  );

ALTER TABLE realtime_tickets
  ADD COLUMN humans_only_channels boolean NOT NULL DEFAULT false;

-- Operators enable creation only after every server and realtime worker understands the marker.
-- Once one upgraded node enables a workspace, all upgraded nodes keep advertising the feature.
ALTER TABLE workspaces
  ADD COLUMN humans_only_channels_available boolean NOT NULL DEFAULT false;

CREATE FUNCTION reject_user_kind_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind IS DISTINCT FROM NEW.kind THEN
    RAISE EXCEPTION 'user kind is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_kind_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_reject_kind_change
BEFORE UPDATE OF kind ON users
FOR EACH ROW
EXECUTE FUNCTION reject_user_kind_change();

CREATE FUNCTION validate_humans_only_conversation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.human_only IS DISTINCT FROM NEW.human_only THEN
    RAISE EXCEPTION 'channel audience is immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'conversations_human_only_immutable';
  END IF;

  IF NEW.human_only THEN
    -- Channel creation locks every human membership row and then the workspace row. Match that
    -- order here so the insert cannot invert it while it materializes the
    -- compatibility memberships below.
    PERFORM 1
     FROM workspace_memberships AS membership
      JOIN users AS member ON member.id = membership.user_id
     WHERE membership.workspace_id = NEW.workspace_id
       AND member.kind = 'human'
     ORDER BY membership.user_id
       FOR UPDATE OF membership;
    PERFORM 1
      FROM workspaces AS workspace
     WHERE workspace.id = NEW.workspace_id
       FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
        FROM users AS creator
        JOIN workspace_memberships AS creator_membership
          ON creator_membership.workspace_id = NEW.workspace_id
         AND creator_membership.user_id = creator.id
         AND creator_membership.status = 'active'
       WHERE creator.id = NEW.created_by
         AND creator.kind = 'human'
    ) THEN
      RAISE EXCEPTION 'a humans-only channel must be created by a human'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'conversations_human_only_creator';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_validate_humans_only
BEFORE INSERT OR UPDATE OF human_only, created_by ON conversations
FOR EACH ROW
EXECUTE FUNCTION validate_humans_only_conversation();

CREATE FUNCTION validate_humans_only_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_human_only boolean := false;
  new_human_only boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT conversation.human_only
      INTO old_human_only
      FROM conversations AS conversation
     WHERE conversation.id = OLD.conversation_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT conversation.human_only
      INTO new_human_only
      FROM conversations AS conversation
     WHERE conversation.id = NEW.conversation_id;
  END IF;

  IF TG_OP = 'UPDATE' AND (old_human_only OR new_human_only) THEN
    RAISE EXCEPTION 'humans-only channel membership is automatic'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'humans_only_channel_membership_immutable';
  END IF;
  IF TG_OP = 'DELETE' AND old_human_only AND EXISTS (
    SELECT 1
      FROM workspaces AS workspace
      JOIN users AS member ON member.id = OLD.user_id
      JOIN workspace_memberships AS workspace_membership
        ON workspace_membership.workspace_id = OLD.workspace_id
       AND workspace_membership.user_id = OLD.user_id
     WHERE workspace.id = OLD.workspace_id
  ) THEN
    RAISE EXCEPTION 'humans-only channel membership is automatic'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'humans_only_channel_membership_immutable';
  END IF;
  IF TG_OP = 'INSERT' AND new_human_only AND (
    NEW.left_at IS NOT NULL
    OR NEW.role <> 'member'
    OR NOT EXISTS (
      SELECT 1
        FROM users AS member
       WHERE member.id = NEW.user_id
         AND member.kind = 'human'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM workspace_memberships AS workspace_membership
       WHERE workspace_membership.workspace_id = NEW.workspace_id
         AND workspace_membership.user_id = NEW.user_id
         AND workspace_membership.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'non-human principals cannot join a humans-only channel'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'humans_only_channel_human_members';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversation_memberships_validate_humans_only
BEFORE INSERT OR UPDATE OR DELETE ON conversation_memberships
FOR EACH ROW
EXECUTE FUNCTION validate_humans_only_membership();

CREATE FUNCTION reject_humans_only_bot_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM conversations AS conversation
     WHERE conversation.id = NEW.conversation_id
       AND conversation.human_only
  ) THEN
    RAISE EXCEPTION 'bots cannot access a humans-only channel'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'humans_only_channel_no_bots';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_channel_grants_reject_humans_only
BEFORE INSERT OR UPDATE OF conversation_id ON bot_channel_grants
FOR EACH ROW
EXECUTE FUNCTION reject_humans_only_bot_grant();

CREATE FUNCTION seat_humans_in_humans_only_channel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.human_only THEN
    INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
    SELECT NEW.id,
           NEW.workspace_id,
           membership.user_id,
           'member'
      FROM workspace_memberships AS membership
      JOIN users AS member ON member.id = membership.user_id
     WHERE membership.workspace_id = NEW.workspace_id
       AND membership.status = 'active'
       AND member.kind = 'human'
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_seat_humans_only_channel
AFTER INSERT ON conversations
FOR EACH ROW
EXECUTE FUNCTION seat_humans_in_humans_only_channel();

CREATE FUNCTION seat_human_in_humans_only_channels()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1
      FROM users AS member
     WHERE member.id = NEW.user_id
       AND member.kind = 'human'
  ) THEN
    -- Message delivery and channel mutation lock the conversation before the workspace sequence
    -- row. Take every affected conversation in deterministic order before matching that order.
    PERFORM 1
      FROM conversations AS conversation
     WHERE conversation.workspace_id = NEW.workspace_id
       AND conversation.human_only
     ORDER BY conversation.id
       FOR UPDATE;
    PERFORM 1
      FROM workspaces AS workspace
     WHERE workspace.id = NEW.workspace_id
       FOR UPDATE;
    INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
    SELECT conversation.id,
           conversation.workspace_id,
           NEW.user_id,
           'member'
      FROM conversations AS conversation
     WHERE conversation.workspace_id = NEW.workspace_id
       AND conversation.human_only
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER workspace_memberships_seat_humans_only_channels
AFTER INSERT OR UPDATE OF status ON workspace_memberships
FOR EACH ROW
WHEN (NEW.status = 'active')
EXECUTE FUNCTION seat_human_in_humans_only_channels();
