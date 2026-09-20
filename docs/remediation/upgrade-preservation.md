# Upgrade preservation

The protocol upgrade retains authoritative PostgreSQL records, idempotency fingerprints, credentials,
and historical events. Existing workspaces remain inactive until an operator records the replay epoch
and floor. Applying the additive migration again makes no further changes. Retrying an accepted send,
even concurrently after cutover, returns its original message without adding another message or event.

Desktop upgrades run when each signed-in scope opens its IndexedDB database. The transaction clears
only replicated server stores. If that transaction aborts, the complete old database remains and the
next open retries it. The encryption key, associated-data version, database identity and encrypted
outbox operations stay unchanged. Upgrading one scope does not open or migrate other scopes.
Preferences remain in their existing private files.

A complete catalog or membership removal can prove that a queued message's conversation is no longer
accessible. That operation now remains encrypted as a permanent failure with no retry time. Its body,
original message ID and idempotency key are retained. Replicated messages, reactions and tasks for the
removed conversation are still purged; late network responses cannot restore them. Pending sends to
other conversations continue. Retained failed sends are hidden while their conversation is unavailable.
If an administrator restores access, select that conversation and use its existing failed-send edit,
retry or discard controls. Restored access does not automatically retry the old work. This is a local
retention policy for authored work, not permission to fetch a removed conversation's contents.

Hermes replaces its recognized old checkpoint atomically before starting watch. Interrupted replacement
leaves the original bytes and pending read targets available for the next startup. Migration does not
repeat inference for a pending read acknowledgement.

## Drafts and the maintenance window

Composer drafts currently live in React memory. Both open composers retain their text during a live
runtime epoch replacement, and navigation retains each independent draft. They do not survive quitting
an old desktop client or signing out. A cache backup cannot recover text that was never persisted.
Before restarting old clients during cutover, users must save their unsent composer text outside the
app or submit it to the durable outbox while their current session and cache are still available.
Do not describe a forced old-client restart as preserving unsaved composer drafts. A client running
without persistent encryption also needs its local work saved before restart.

## Reproducible checks

`npm run check` includes the following regression families:

- `protocol-epoch.integration.test.ts`: real old PostgreSQL schema, retained authoritative records and
  credentials, lost-acknowledgement replay, explicit activation, expired and wrong-epoch positions.
- `test/cache-epoch-migration.test.ts` and `test/cache-upgrade-preservation.test.ts`: production cipher,
  interrupted IndexedDB upgrade, unchanged ciphertext and key bytes, per-scope migration, preference
  preservation, and retained blocked outbox work after the new catalog arrives.
- `workspace-cache-conformance.test.ts` and `workspace-runtime.test.ts`: both caches, staged pages,
  concurrent membership removals, late send/history responses, retractions, and unrelated delivery
  while a revoked conversation's queued operation remains blocked, followed by restored access and
  explicit retry with the original message ID.
- `app-upgrade-drafts.test.ts`: both live composer drafts through the runtime's epoch replacement.
- Hermes `test_adapter.py`: old cursor migration and restart after interrupted checkpoint replacement.

Fresh Electron keyboard and navigation screenshots are in `docs/screenshots/upgrade-preservation-*.png`.
They use the isolated demo and a memory cache. The encrypted migration tests use the production cipher
with OS key wrapping substituted and fake IndexedDB. Native OS key stores, installed updater migration,
signed packages and the production backup restore still require the release rehearsal.
