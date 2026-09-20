# Collection loading

A workspace sync position certifies processed events. A collection snapshot position records the
PostgreSQL snapshot used for that page. Loading history, a thread, tasks, or files never advances
the workspace acknowledgement position.

History and thread responses include reactions, attachments and their read position from the same
repeatable-read transaction. Task and file pages use that transaction policy too. The history
integration test blocks an attachment query, commits a reaction on another connection, and checks
that the blocked page retains its original reaction list and position.

`workspace-collections.ts` defines identities for a conversation timeline, a thread root, a
conversation task board, My Tasks and conversation files. Each identity has independent loaded
state, snapshot position, next cursor and invalidation position. An absent identity means not
loaded. Empty pages become loaded only after their cache transaction commits.

History and task page writes commit their collection metadata with their records. They reject a
superseded global position or page cursor. They retain existing message tombstones and newer task
versions. File rows remain session state; their cached query metadata does not certify offline
file availability. Restoring a cache marks those file collections unloaded.

A collection request owns a bounded journal of events committed while it fetches. Realtime keeps
committing and acknowledging events through the ordinary cache path. Before the page commits, the
loader replays journal events newer than the page position against its records. This replay does
not call event acknowledgement or repeat unread accounting. A journal accepts at most 1,024 events
and 4 MiB, using the shared client limits. Overflow discards the fetched page and retries up to
three times. Membership repair, session replacement and resync retire pending publication. Local
mutations and attachment hydration retire affected reads when their changes cannot be reconstructed
from the event payload.

A message row also retains the snapshot position of its fetched reactions. This prevents an event
older than a committed page from undoing that page when the event stream subsequently catches up.
The event still advances the durable global position. Persistent and memory caches apply the same
rule. Thread summary positions serve the corresponding purpose for renderer aggregates.

An event affecting a collection records invalidation even if that collection has never loaded.
Refreshing the first page clears only invalidation at or before that page's position. Later pages
retain the first page's snapshot position and require its existing pagination state. A newer invalidation
remains visible to recovery policy. The next remediation steps replace eager startup hydration and
assign collection recovery ownership; this change retains the existing startup orchestration and
loads all requested task/file pages, committing each at its own position.

Metadata refresh has a separate cache operation. It replaces the complete conversation catalog only
at the applied workspace position, preserves retained collection records and reaction positions,
and removes rows for revoked conversations in the same transaction. A page committed during
metadata encryption survives the refresh. This operation does not advance acknowledgement.
