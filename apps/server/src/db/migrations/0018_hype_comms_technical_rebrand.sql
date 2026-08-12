-- Message body format literal rename. 0002 created an inline CHECK that must move too,
-- or inserts of the new literal fail after deploy.
ALTER TABLE messages DROP CONSTRAINT messages_body_format_check;

UPDATE messages
   SET body_format = 'hype_comms_markdown_v1'
 WHERE body_format = 'hmm_markdown_v1';

ALTER TABLE messages
  ADD CONSTRAINT messages_body_format_check
  CHECK (body_format = 'hype_comms_markdown_v1');

-- Workspace slug rename. 0008 renamed only the display name; slug was left alone.
UPDATE workspaces
   SET slug = 'hype-comms',
       updated_at = clock_timestamp()
 WHERE slug = 'hmm-chat'
   AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = 'hype-comms');
