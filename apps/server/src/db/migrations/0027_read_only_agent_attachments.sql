-- Attachment writes are a separate capability from posting messages. Preserve active deployed
-- agents' effective access without rewriting their stored scope arrays: the previous server must
-- remain able to parse and authenticate those rows during a rolling deploy and rollback window.
-- New servers project these additive compatibility markers as effective channels:join and
-- attachments:write scopes. Future credentials store explicit scopes and leave both markers false.
CREATE OR REPLACE FUNCTION valid_agent_scopes(candidate text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(candidate) BETWEEN 1 AND 8
    AND candidate <@ ARRAY[
      'workspace:read',
      'messages:write',
      'conversations:write',
      'read-cursors:write',
      'direct-conversations:write',
      'channels:join',
      'agents:invite',
      'attachments:write'
    ]::text[]
    AND cardinality(candidate) = (
      SELECT count(DISTINCT scope_name)::integer
      FROM unnest(candidate) AS scope_name
    )
$$;

ALTER TABLE agent_tokens
  ADD COLUMN inherited_channels_join boolean,
  ADD COLUMN inherited_attachments_write boolean;

UPDATE agent_tokens AS token
   SET inherited_channels_join = token.revoked_at IS NULL
         AND 'workspace:read' = ANY(token.scopes),
       inherited_attachments_write = token.revoked_at IS NULL
         AND 'messages:write' = ANY(token.scopes);

-- Old servers omit both columns. The NULL sentinel lets the trigger distinguish that legacy
-- insert from a new server deliberately inserting false for a narrowly scoped credential.
CREATE FUNCTION set_inherited_agent_token_scopes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.inherited_channels_join IS NULL THEN
    NEW.inherited_channels_join := NEW.revoked_at IS NULL
      AND 'workspace:read' = ANY(NEW.scopes);
  END IF;
  IF NEW.inherited_attachments_write IS NULL THEN
    NEW.inherited_attachments_write := NEW.revoked_at IS NULL
      AND 'messages:write' = ANY(NEW.scopes);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_tokens_set_inherited_scopes
BEFORE INSERT ON agent_tokens
FOR EACH ROW
EXECUTE FUNCTION set_inherited_agent_token_scopes();

ALTER TABLE agent_tokens
  ALTER COLUMN inherited_channels_join SET NOT NULL,
  ALTER COLUMN inherited_attachments_write SET NOT NULL;

DROP TRIGGER agent_tokens_scopes_immutable ON agent_tokens;

CREATE OR REPLACE FUNCTION reject_agent_token_scope_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.inherited_channels_join IS DISTINCT FROM OLD.inherited_channels_join
     OR NEW.inherited_attachments_write IS DISTINCT FROM OLD.inherited_attachments_write THEN
    RAISE EXCEPTION 'agent token scopes are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_tokens_scopes_immutable
BEFORE UPDATE OF scopes, inherited_channels_join, inherited_attachments_write ON agent_tokens
FOR EACH ROW
EXECUTE FUNCTION reject_agent_token_scope_change();
