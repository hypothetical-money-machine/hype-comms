# SQLite retirement

The SQLite prototype is retired. Hype Comms now uses PostgreSQL for identity, conversations,
messages, read cursors, idempotency records, and sync events. The removed `/v1/chat/*` API has no
compatibility path.

The legacy SQLite `#welcome` history was not imported. It does not contain the stable member,
conversation, or event identifiers required by the PostgreSQL model. Keep any retained SQLite file
as a restricted read-only archive with its filename, size, capture time, and SHA-256 checksum.

PostgreSQL migrations are forward-only. Do not restart the retired SQLite service against new
writes. Application rollback is limited to builds that understand the PostgreSQL schema and API;
restoring a legacy archive is an incident response task, not an application rollback.
