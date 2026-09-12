# Workspace recovery and subscriptions

`WorkspaceRecovery` owns pending and blocked recovery work. Starting work returns a lease. Completion,
phase changes and failure reports affect only the matching lease; a newer demand or session reset
retires the old one. Published recovery snapshots retain their identity until work changes.

Startup owns metadata loading, replica catch-up and realtime activation as phases of one lease.
Catalog requests, event sync, resync demands, membership repair, member-directory invalidation and
source-less retraction repair have separate leases. Retry counters, request IDs, accepted membership
frames, durable repair markers, cache identity and cancellation signals still govern data access and
publication. A recovery lease does not authorize a write or acknowledge an event.

The runtime derives workspace staleness from missing bootstrap data and outstanding workspace work.
Successful member refresh therefore cannot declare an unfinished catalog or resync current. Failed
local replica writes remain blocked until authoritative replacement or session restart repairs them.
Full replacement settles only invalidations captured before its request began.

Each collection request owns a separate lease. Its failure keeps a blocked entry for that collection
without making unrelated chat stale. `collectionStale` combines that work with loaded state and
snapshot invalidation. A collection that has not loaded never becomes current because global sync
completed. Collection snapshot invalidation is distinct from a currently pending recovery request. The header
shows recovery for the selected pane and retries its loader independently when global recovery is
settled. Healthy realtime events do not produce a persistent warning merely because their sequence
is newer than the collection's original read position.

`createWorkspaceSelection` preserves equal selected snapshots and notifies subscribers only when
their selection changes. Each subscription tracks its last notified snapshot separately from reads,
so another reader cannot consume a change before its notification. React uses these selections with
`useSyncExternalStore`.

App selects workspace state without typing. Each composer renders a `WorkspaceTypingIndicator` that
subscribes to its own conversation's formatted typing text. The App test exercises real activity
frames and expiry while counting navigation renders. Presence still belongs to the main workspace
view; a later sidebar extraction can narrow that subscription independently.
