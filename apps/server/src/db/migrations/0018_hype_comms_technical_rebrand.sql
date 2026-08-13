-- Message body format literal rename. 0002 created an inline CHECK that must move too,
-- or inserts of the new literal fail after deploy.
ALTER TABLE messages DROP CONSTRAINT messages_body_format_check;

UPDATE messages
   SET body_format = 'hype_comms_markdown_v1'
 WHERE body_format = 'hmm_markdown_v1';

ALTER TABLE messages
  ADD CONSTRAINT messages_body_format_check
  CHECK (body_format = 'hype_comms_markdown_v1');

-- Retained sync event payloads embed the message entity verbatim, so rewriting
-- messages.body_format alone leaves 'hmm_markdown_v1' behind in sync_events.payload.
-- WorkspaceRepository.#mapEvent strictly parses those payloads with workspaceEventSchema,
-- so a single retained message.created event would throw and break catch-up sync and
-- realtime reconnection until the event aged out of retention.
-- message.created is the only event type whose payload embeds a message, and the value is a
-- scalar (never inside an array), so jsonb_set on a fixed path is sufficient.
UPDATE sync_events
   SET payload = jsonb_set(payload, '{message,bodyFormat}', '"hype_comms_markdown_v1"')
 WHERE event_type = 'message.created'
   AND payload #>> '{message,bodyFormat}' = 'hmm_markdown_v1';

-- The same literal is persisted in api_idempotency_records.response_body, which
-- withIdempotency replays through a strict responseSchema.parse.
UPDATE api_idempotency_records
   SET response_body = jsonb_set(response_body, '{message,bodyFormat}', '"hype_comms_markdown_v1"')
 WHERE response_body #>> '{message,bodyFormat}' = 'hmm_markdown_v1';

UPDATE api_idempotency_records
   SET response_body = jsonb_set(
         response_body,
         '{conversation,lastMessage,bodyFormat}',
         '"hype_comms_markdown_v1"'
       )
 WHERE response_body #>> '{conversation,lastMessage,bodyFormat}' = 'hmm_markdown_v1';

-- Session cutover. The cookie renamed hmm_session -> hype_comms_session, but the token inside it
-- is an unprefixed secret, so a client that replays its pre-cutover token under the new cookie
-- name still authenticates: IdentityService.authenticateContext only hashes the presented value
-- and looks for a matching unrevoked device_sessions row. Revoke every session that predates the
-- cutover so the documented "all sessions invalidated" is actually enforced, using the same
-- semantics as IdentityRepository.revokeAllDeviceSessions (stamp revoked_at, drop the provider
-- session link) rather than DELETE, which would also discard the audit trail and cascade away
-- device_session_token_history. Revoked sessions are equally refused by realtime ticket
-- redemption and WebSocket re-authorization, which both require revoked_at IS NULL. The guard
-- makes this idempotent and keeps an already-recorded revocation timestamp intact.
UPDATE device_sessions
   SET revoked_at = clock_timestamp(),
       workos_session_id = NULL
 WHERE revoked_at IS NULL;

-- Workspace slug rename. 0008 renamed only the display name; slug was left alone.
UPDATE workspaces
   SET slug = 'hype-comms',
       updated_at = clock_timestamp()
 WHERE slug = 'hmm-chat'
   AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = 'hype-comms');
