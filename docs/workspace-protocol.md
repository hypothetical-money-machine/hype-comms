# Workspace protocol 2

This is a coordinated breaking release. The `/v2` implementation is one layer of the remediation
program, not permission to deploy before the replay-epoch and migration work is complete.

## Supported operations

Desktop and CLI use `/v2` for first-party workspace and identity operations. The server produces
one canonical shape. Feature flags control availability, scope and resource checks control access,
and platform checks control local presentation. None selects an older JSON projection.

These externally configured routes remain stable: `/auth/magic-link`,
`/v1/auth/workos/callback`, `/v1/auth/workos/webhook`, and `/v1/webhooks/incoming/:token`.
External polling jobs are outside this change. Inventory their configured endpoints before
cutover; a job depending on retired first-party endpoints must be resolved before the window.

Unsupported versioned product endpoints return HTTP 426 with the existing strict `CONFLICT`
envelope and an upgrade message. API responses carry `x-hype-comms-protocol: 2`. Clients recognize
426, a conflicting major, or an unmarked success/404 as incompatible. An unmarked 429 or gateway
5xx remains a transient failure. Desktop retains credentials and local work while automatic
network retries stop. CLI reports `UPGRADE_REQUIRED` with `retryable: false`.

## Durable state

Do not rename stored `/v1` idempotency operation keys when moving HTTP routes. Retrying a committed
operation must reuse its original identity and return the accepted result. Historical migrations
and historical events remain unchanged. Active tickets no longer read capability columns; those
columns keep their defaults until the later cleanup migration.

The next remediation layer must add the durable protocol epoch and replay floor, carry positions
as `{ epoch, sequence }`, and reject wrong-epoch or expired positions with rebootstrap. Clients must
preserve outbox records, encryption keys, drafts, and preferences while replacing replicated data.
Stored mutation responses that cannot parse under the new contract need normalization without
repeating their mutation. These preservation requirements are not yet release-verified.

## Release gate

Complete the roadmap's database/local-cache preservation fixtures and native package rehearsal
before publishing protocol 2. Prepare matching desktop packages for every supported platform,
server, CLI, Hermes adapter, and a compatible rollback build. Stop all product writers, back up the
database, record the cutover position, apply additive migrations, and establish the new epoch and
floor. Verify login, send/reply, attachments, tasks, reconnect, and preserved outbox delivery before
reopening writes.

Before reopening writes, rollback may restore the coordinated pre-cutover state. Afterwards use a
protocol-2-compatible rollback build or roll forward; never restore an old snapshot over new
messages. Remove unused capability columns and transitional protocol code only after one complete
successful production release cycle. Keep historical migrations.
