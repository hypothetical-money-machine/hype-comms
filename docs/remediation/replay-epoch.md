# Workspace replay epoch

Protocol 2 identifies replay positions as `{ epoch, sequence }`. The epoch is a workspace UUID;
the sequence is the existing decimal PostgreSQL event sequence. Bootstrap, sync, event envelopes,
realtime tickets and desktop acknowledgements use this shape. The `after` HTTP query and CLI option
contain its JSON encoding. Conversation sequences and history/list pagination cursors do not change.

Migration `0032_workspace_protocol_epoch.sql` is additive. Existing workspaces remain inactive until
the maintenance command establishes their epoch and replay floor. Newly created workspaces receive
a fresh epoch with floor zero. The migration retains messages, credentials, historical events and
idempotency records. Replay below the floor or from another epoch requires an authoritative bootstrap;
the server never projects historical events below the floor into protocol 2.

## Operator command

The command is available as `npm run protocol:epoch --workspace @hype-comms/server -- ...`, or
`protocol:epoch:dist` in a built deployment. It uses the server's existing environment configuration.
Use it during the coordinated maintenance window after the release rehearsal, with all product
writers stopped. The command does not stop services or create a backup.

1. Stop every product writer and take the maintenance backup.
2. Apply the additive migration using the real server migrator.
3. Run `inspect --workspace-id UUID`. Save the JSON output with the backup record.
4. Choose and record a new UUID. Run `activate --workspace-id UUID --expected-epoch none
   --expected-sequence N --epoch NEW_UUID --writers-stopped`. Use the inspected epoch instead of
   `none` if the workspace already has one. The expected sequence must match the saved inspection.
5. Save the returned epoch and floor before starting matching protocol-2 packages.

Activation locks the workspace row and refuses an intervening epoch or sequence change. Retrying
with the same recorded arguments returns the established floor; it does not move that floor over
later messages. If output is lost or the process is interrupted, retry those same arguments.

A previously accepted mutation retains its original key and request fingerprint. Its stored response
position is normalized to the current epoch and at least the replay floor. The mutation is not run
again. Already-current receipts are not rewritten. Mutation response positions never acknowledge
unprocessed events in the desktop cache.

## Local upgrade

Desktop IndexedDB version 6 clears replicated server records and obsolete recovery metadata in a
transaction. It retains the encrypted outbox in the same database. The database name, key identity,
cipher and associated-data version remain unchanged. A protocol reset within version 6 follows the
same preservation rule. Pending sends are retried with their original idempotency keys after the new
bootstrap verifies current access. Main accepts acknowledgements only within the prepared epoch.

A reset invalidates queued realtime frames and pending member writes before awaiting shutdown.
Notifications establish a fresh baseline and ignore late frames from the previous epoch. Hermes
migrates scalar version 1/2 checkpoints to a version 3 position after bootstrap, preserving version 2
pending read targets. Existing external polling jobs are unaffected.

## Verification and release limits

`protocol-epoch.integration.test.ts` exercises the real PostgreSQL migration, cutover command,
retained records, stale activation rejection and accepted mutation retries. The desktop integration
test `test/cache-epoch-migration.test.ts` runs the production cipher and IndexedDB upgrade together,
checks unchanged ciphertext and key bytes, and reopens an interrupted send as pending. The runtime
queued-frame regression blocks bootstrap after reset to expose writes from an obsolete epoch.

These checks prepare the coordinated release. Production cutover, native package/update rehearsal,
restartable per-scope migration beyond this replica upgrade, and the full local-work preservation
matrix remain milestone 6 work. Do not remove historical migrations or old capability columns in
this layer. After writes reopen, use a compatible rollback build or roll forward; restoring an old
snapshot would discard newly accepted messages.
