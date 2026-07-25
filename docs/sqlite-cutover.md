# SQLite-to-PostgreSQL cutover

The PostgreSQL conversation and sync model replaces the access-code/SQLite prototype. The
server and desktop are a coordinated cutover: there is no compatibility window for the
removed `/v1/chat/*` API.

## Before deployment

1. Stop writes to the old service.
2. Copy the legacy SQLite file out of the deployment volume to restricted archival storage.
3. Record its filename, byte size, UTC capture time, and SHA-256 checksum.
4. Verify that the archive opens read-only, then remove the live SQLite volume only after the
   archive has been independently retained.
5. Back up PostgreSQL and verify the target has the identity/auth migrations already applied.

The SQLite `#welcome` history is not imported. It has no stable per-member identity or
conversation/event sequence compatible with the new model, so inventing a mapping would weaken
attribution and idempotency guarantees. It remains an external historical archive only.

## Deploy

1. Deploy the server and apply `0002_conversation_core.sql` under the migration advisory lock.
2. Verify `/readyz`, owner sign-in, `#general`, and PostgreSQL backup visibility.
3. Distribute the matching desktop build.
4. Exchange one channel message and one DM between two invited members, disconnect and restart
   one client, then verify it converges through `/v1/sync`.
5. Interrupt a send after the server commits but before the client receives the response. Restart
   the client and verify the queued retry resolves to the original server message.

## Rollback boundary

The migration is forward-only and must not be edited after application. Application rollback is
safe only to a build that understands the new schema and API. The retired SQLite service must not
be restarted against new writes; restoration of the old archive is an explicit incident decision,
not an application rollback.
