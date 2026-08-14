# Hype Comms roadmap

Hype Comms is the desktop team chat we (Morgan and Dan) build and use for our own day-to-day
communication. It is one workspace and two people today, but it is written like a product:
the identity, sync, and security models are the ones we would want at small-team scale, so
growing it — or eventually selling it — should be a matter of adding capability, not
rewriting foundations.

The implementation contract and security boundaries live in
[`docs/architecture.md`](docs/architecture.md).

## How we ship across platforms

macOS, Windows, and Linux are supported release targets, but feature parity is not a prerequisite
for useful progress. We may design, implement, merge, and release a capability for one platform or
a stated subset while preserving the existing behavior elsewhere. Unsupported variants stay
visible as follow-up work instead of blocking the platform that is ready.

Cross-platform delivery becomes one gate only when a specific item says so or when a shared
security, data, compatibility, or release invariant makes a partial rollout unsafe. Otherwise,
acceptance and native evidence are scoped to the platforms named by the work. See
[`ADR 0003`](docs/adr/0003-platform-scoped-delivery.md).

## Built and working

- Invite-only access: optional WorkOS AuthKit plus email-bound single-use magic links, rotating
  revocable device sessions with pre-expiry renewal, signed upstream-session revocation plus
  active-session reconciliation, and credentials confined to Electron main behind validated IPC.
- A PostgreSQL-authoritative conversation core: workspace channels, unique 1:1 DMs,
  paginated history, and server-authoritative unread/mention counters.
- Workspace-visible and members-only channels with owner-managed membership, server-enforced
  visibility at list/history/send/sync boundaries, and immediate cache purge on removal.
- Date separators in the main message timeline, including pending outbox messages.
- Unicode emoji reactions with grouped counts, quick add/remove controls, encrypted local
  persistence, authorized batch hydration, and realtime convergence.
- Channel task projects with Board and List views, canonical three-column Kanban ordering,
  assignments/priorities/due dates, message-to-task links, realtime convergence, and a self-DM
  My Tasks list that can include assigned work from other visible boards.
- First-class bot members with owner-issued, hashed, expiring task credentials, read/write scopes,
  explicit per-channel grants, one-time token display, rotation/revocation, channel-slug/task-number
  lookup, filtered polling, and latest-mutation actor attribution.
- One-level message threads with root-only conversation history, accurate reply summaries,
  paginated reply panes, reply-aware search and read state, and restart-safe queued replies.
- Authorized, ranked PostgreSQL message-body search across visible channels and DMs; selecting a
  result opens and highlights it in the main timeline.
- Every mutation commits together with its ordered sync event in one transaction; clients
  converge through a ticketed reconnecting WebSocket plus cursor-based HTTP sync.
- An encrypted IndexedDB cache and a restart-safe outbox: one UUID serves as both client
  message ID and idempotency key, so a retried send never duplicates and a failed send is
  never silently discarded.
- Structured request logs, liveness/readiness probes, and an optional authenticated Prometheus
  endpoint for HTTP, realtime-connection, and PostgreSQL-pool health.
- Native-notification Milestones 0 through 3 behind default-off build and device settings: direct
  messages, verified mentions, capability-gated participated-thread replies, exact scoped
  click-through, stable preferences/capability state, and replica-first macOS window recreation are
  covered deterministically.

Deliberate current constraints: one workspace, at most 25 active members, immutable
messages, desktop only. Each is enforced in code and gets lifted on purpose, not by
accident.

## Now: move ourselves onto it

- Run the SQLite-to-PostgreSQL cutover ([`docs/sqlite-cutover.md`](docs/sqlite-cutover.md))
  and retire the prototype data path.
- Verify two-client convergence for real: exchange channel and DM messages while one client
  goes offline, restarts, or is disconnected mid-send, and confirm the queued retry resolves
  to one canonical server message.
- Use it daily. Anything that pushes either of us back to another tool goes to the top of
  the backlog.

## Next: good enough to prefer

Roughly in order:

- Structured mention completion on the existing verified mention model.
- File attachments: quarantined direct uploads, malware scanning, expiring downloads, and
  authorized filename search.
- Finish the [native notifications](docs/native-notifications-roadmap.md) rollout platform by
  platform. The signed/notarized macOS release artifact is the first opt-in pilot; collect its
  installed Milestone 4 display/click/lifecycle evidence while Windows and Linux remain compiled
  off. Let each platform ship after its applicable gate rather than blocking on the combined
  macOS, Windows, and Linux matrix; keep every platform's device preference default-off until its
  own gate passes.
- Close the remaining release-signature gaps: procure a Windows Authenticode certificate and add
  an independent signature gate, then add Linux detached signatures/SBOM/provenance. macOS signing
  and notarization plus the cross-platform update feed are already running.
- A small hosted deployment (the AWS/Cloudflare target in `docs/architecture.md`) once
  daily use justifies it.

## Later: opening it up

Direction, not commitment — revisit once we are happily living in it:

- Multiple workspaces and inviting other small teams.
- Message editing and deletion, group DMs, presence and typing indicators — table stakes
  for anyone who is not us.
- Browser and mobile clients; the renderer already sits behind a transport interface for
  exactly this reason.
- Extend the agent-native foundation beyond tasks: event delivery, richer audit history, safe bot
  messaging, and in-app owner management. Agents already have first-class identities, explicit
  channel grants, scoped task capabilities, and task actor attribution.
- Pricing, packaging, Slack import, and the enterprise/compliance backlog — only if and
  when this becomes a product with users beyond us.

## What we protect at any scale

Whatever gets built next keeps these invariants: PostgreSQL is the single source of truth;
realtime delivery is a hint repaired over HTTP; sends are idempotent and the outbox is
never lost; every query is authorized server-side; and the renderer never holds
credentials.
