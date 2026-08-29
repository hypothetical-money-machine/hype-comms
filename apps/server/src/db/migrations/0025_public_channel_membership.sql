-- Public channels become explicitly joinable for conversational agents. Existing agent/channel
-- pairs are backfilled as real seats. During a rolling deploy, reciprocal triggers also seat an
-- agent or public channel inserted by an old writer; both paths take the workspace lock so a
-- concurrent pair cannot miss each other. New servers mark agents non-legacy and, after cutover,
-- mark new channels as requiring explicit membership, so no future channel is inherited.
CREATE OR REPLACE FUNCTION valid_agent_scopes(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(candidate) BETWEEN 1 AND 7
    AND candidate <@ ARRAY[
      'workspace:read',
      'messages:write',
      'conversations:write',
      'read-cursors:write',
      'direct-conversations:write',
      'channels:join',
      'agents:invite'
    ]::text[]
    AND cardinality(candidate) = (
      SELECT count(DISTINCT scope_name)::integer
      FROM unnest(candidate) AS scope_name
    )
$$;

ALTER TABLE agents
  ADD COLUMN legacy_public_channel_access boolean;

ALTER TABLE conversations
  ADD COLUMN agent_membership_required boolean;

ALTER TABLE workspaces
  ADD COLUMN default_agent_agency_available boolean NOT NULL DEFAULT false;

UPDATE agents AS agent
   SET legacy_public_channel_access = agent.disabled_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM workspace_memberships AS membership
        WHERE membership.workspace_id = agent.workspace_id
          AND membership.user_id = agent.user_id
          AND membership.status = 'active'
     );

UPDATE conversations
   SET agent_membership_required = false;

CREATE FUNCTION set_legacy_public_channel_access()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  agency_available boolean;
BEGIN
  IF NEW.legacy_public_channel_access IS NULL THEN
    SELECT default_agent_agency_available
      INTO agency_available
      FROM workspaces
     WHERE id = NEW.workspace_id
     FOR UPDATE;
    NEW.legacy_public_channel_access := NOT coalesce(agency_available, false);
  ELSIF NEW.legacy_public_channel_access THEN
    PERFORM 1
      FROM workspaces
     WHERE id = NEW.workspace_id
     FOR UPDATE;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agents_set_legacy_public_channel_access
BEFORE INSERT ON agents
FOR EACH ROW
EXECUTE FUNCTION set_legacy_public_channel_access();

ALTER TABLE agents
  ALTER COLUMN legacy_public_channel_access SET NOT NULL;

CREATE FUNCTION set_agent_membership_requirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  agency_available boolean;
BEGIN
  IF NEW.kind = 'channel'
     AND NEW.channel_access = 'workspace' THEN
    SELECT default_agent_agency_available
      INTO agency_available
      FROM workspaces
     WHERE id = NEW.workspace_id
     FOR UPDATE;
    NEW.agent_membership_required := coalesce(NEW.agent_membership_required, false)
      OR coalesce(agency_available, false);
  ELSE
    NEW.agent_membership_required := coalesce(NEW.agent_membership_required, false);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_set_agent_membership_requirement
BEFORE INSERT ON conversations
FOR EACH ROW
EXECUTE FUNCTION set_agent_membership_requirement();

ALTER TABLE conversations
  ALTER COLUMN agent_membership_required SET NOT NULL;

CREATE FUNCTION seat_legacy_agent_in_public_channels()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.legacy_public_channel_access THEN
    INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
    SELECT conversation.id,
           conversation.workspace_id,
           NEW.user_id,
           CASE WHEN conversation.created_by = NEW.user_id THEN 'owner' ELSE 'member' END
      FROM conversations AS conversation
      JOIN workspace_memberships AS membership
        ON membership.workspace_id = NEW.workspace_id
       AND membership.user_id = NEW.user_id
       AND membership.status = 'active'
     WHERE conversation.workspace_id = NEW.workspace_id
       AND conversation.kind = 'channel'
       AND conversation.channel_access = 'workspace'
       AND NOT conversation.agent_membership_required
    ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET left_at = NULL,
          updated_at = clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agents_seat_legacy_public_channels
AFTER INSERT ON agents
FOR EACH ROW
EXECUTE FUNCTION seat_legacy_agent_in_public_channels();

CREATE FUNCTION seat_legacy_agents_in_public_channel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'channel'
     AND NEW.channel_access = 'workspace'
     AND NOT NEW.agent_membership_required THEN
    INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
    SELECT NEW.id,
           NEW.workspace_id,
           agent.user_id,
           CASE WHEN NEW.created_by = agent.user_id THEN 'owner' ELSE 'member' END
      FROM agents AS agent
      JOIN workspace_memberships AS membership
        ON membership.workspace_id = agent.workspace_id
       AND membership.user_id = agent.user_id
       AND membership.status = 'active'
     WHERE agent.workspace_id = NEW.workspace_id
       AND agent.disabled_at IS NULL
       AND agent.legacy_public_channel_access
    ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET left_at = NULL,
          updated_at = clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_seat_legacy_agents
AFTER INSERT ON conversations
FOR EACH ROW
EXECUTE FUNCTION seat_legacy_agents_in_public_channel();

INSERT INTO conversation_memberships (
  conversation_id,
  workspace_id,
  user_id,
  role
)
SELECT conversation.id,
       conversation.workspace_id,
       agent.user_id,
       CASE WHEN conversation.created_by = agent.user_id THEN 'owner' ELSE 'member' END
  FROM conversations AS conversation
  JOIN agents AS agent ON agent.workspace_id = conversation.workspace_id
  JOIN workspace_memberships AS workspace_membership
    ON workspace_membership.workspace_id = agent.workspace_id
   AND workspace_membership.user_id = agent.user_id
 WHERE conversation.kind = 'channel'
   AND conversation.channel_access = 'workspace'
   AND agent.disabled_at IS NULL
   AND workspace_membership.status = 'active'
ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET left_at = NULL,
      updated_at = clock_timestamp();
