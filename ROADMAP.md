# HMM Chat roadmap

HMM Chat is a private, desktop-first replacement for the parts of Slack used by one
Hypothetical Money Machine workspace. The pilot supports at most 25 active members on
macOS, Windows, and Linux. It is not a general-purpose, multi-tenant chat product.

The original Go server and terminal client are preserved at the annotated tag
`prototype-go-tui-2025-11-30`. `main` is a fresh Electron/TypeScript implementation; no
prototype code is carried forward unless a later change deliberately ports and tests a
behavior.

The implementation contract and security boundaries live in
[`docs/architecture.md`](docs/architecture.md). A milestone is complete only when its exit
gate passes in CI or in the named hosted environment, its operational signals exist, and
user-facing failure states are handled.

## M0 — Repository and secure desktop foundation

Build the smallest cross-platform shell and server on which the product can safely grow.

- Establish npm workspaces for the Electron client, Fastify service, and versioned shared
  contracts, with one pinned Node/npm toolchain and repeatable checks.
- Start Electron with sandboxing, context isolation, a restrictive CSP, narrow validated
  preload APIs, and no renderer access to Node.js or authentication secrets.
- Start Fastify with request IDs, structured redacted logging, configuration validation,
  health endpoints, and shared request/event schemas.
- Package unsigned smoke artifacts on native macOS, Windows, and Linux CI runners. Reserve
  signed packaging and publishing for the protected release workflow in M4.

Exit gate:

- A clean checkout passes format, lint, type, unit, build, and package-smoke checks.
- The desktop opens a renderer, can call only the allowlisted preload surface, and reports
  API reachability without exposing a token or privileged Electron API.
- The prototype tag can be checked out and the new `main` history contains no Go runtime
  dependency.

## M1 — Private access and hosted vertical slice

Deploy an invite-only path from email to an authenticated desktop session.

- Provision Cloudflare as the public DNS/WAF/TLS edge and AWS for the Fastify service,
  PostgreSQL, private attachment/update storage, email delivery, keys, secrets, logs, and
  backups.
- Seed one owner for one workspace. Add owner-managed, email-bound invitations, single-use
  magic links, rotating sessions, logout, device-session revocation, and the 25-active-member
  limit.
- Store access credentials only in the Electron main process; persist refresh credentials
  with `safeStorage` and require an OS credential store.
- Deliver a minimal authenticated workspace/member view through the production API and
  realtime connection.

Exit gate:

- An owner can invite two fresh addresses, and each person can sign in from a packaged app,
  restart it, refresh a session, and log out. Expired, reused, revoked, uninvited, and
  over-capacity attempts fail without leaking account existence.
- Full-strict TLS works at both network hops; RDS, S3, snapshots, and log storage are
  encrypted with managed keys; no public database or object bucket exists.
- Alerts cover API health, authentication failures, database capacity, and email delivery;
  a point-in-time database restore has been rehearsed in a non-production environment.

## M2 — Reliable conversation core

Make ordinary text chat dependable before adding breadth.

- Add workspace-visible channels and unique 1:1 direct conversations, recent paginated
  history, and server-authoritative unread/mention counters.
- Persist every mutation and its ordered sync event in PostgreSQL. Deliver events over a
  reconnecting WebSocket and repair gaps through cursor-based HTTP sync.
- Cache recent normalized history in renderer-owned IndexedDB. Persist an outbox with a
  stable client message ID and idempotency key, retry queued text sends after restart, and
  reconcile optimistic messages with the canonical server result.
- Expose clear pending, retrying, permanently failed, offline, reconnecting, and stale-cache
  states. A failed send is never silently discarded.

Exit gate:

- Two clients exchange channel and DM messages in realtime and converge after either client
  is offline, suspended, restarted, or disconnected during the server response.
- Replaying the same send any number of times creates one server message; reusing its key
  with different content returns a conflict.
- Duplicate, delayed, and out-of-order events do not duplicate or regress UI state. An
  expired cursor triggers a safe snapshot rebuild while unsent outbox entries survive.
- Authorization tests prove that a non-participant cannot fetch, sync, search, or receive a
  DM, including by guessing identifiers.

## M3 — Collaboration-complete pilot

Add the remaining collaboration workflows without changing the reliable sync model.

- Add one-level message threads, idempotent emoji reactions, structured user mentions, and
  unread behavior across channels, DMs, and thread replies.
- Add private direct uploads to a quarantine area, malware scanning, attachment metadata,
  expiring downloads, and cleanup of rejected or abandoned uploads.
- Add PostgreSQL full-text search across authorized message text and filenames with stable
  cursor pagination.
- Add native notifications for DMs, mentions, and relevant thread replies, with focus/self
  suppression and click-through to the cached or freshly fetched conversation.

Exit gate:

- The complete feature acceptance suite passes with three users on each supported OS,
  including denied notification permission, Unicode/emoji, large histories, an infected
  test file, search ACLs, and a thread or message arriving while offline.
- Files cannot be downloaded before a clean scan or after authorization is removed. Search
  never returns inaccessible DM content or unscanned attachment URLs.
- An unread marker and mention count converge across two devices after read updates and
  reconnects; other members are not shown private read receipts.

## M4 — Signed private pilot

Harden, release, and operate the build for real users.

- Build signed/notarized macOS artifacts for Apple silicon and Intel, signed Windows 11 x64
  installers, and checksum/GPG-signed Linux x64 AppImage and Debian packages.
- Publish release metadata only from a protected workflow. Require an authenticated update
  check and short-lived download URL; verify signatures/checksums before installing. Support
  automatic updates on macOS/Windows and explicit signed-package updates on Linux.
- Complete dependency, IPC/CSP, authorization, rate-limit, backup/restore, log-redaction,
  upgrade/rollback, and incident-response reviews.
- Load test 25 simultaneously connected members with at least 100,000 messages, exercise a
  rolling service deploy and database migration, and document support ownership.

Exit gate:

- A previous signed release upgrades successfully on every supported package/architecture;
  tampered artifacts and metadata are rejected. The server remains compatible with the
  current and immediately previous desktop release.
- At pilot load, message-create-to-event latency is below 500 ms at p95 and search is below
  one second at p95, excluding client network time. The service meets a 99.5% monthly
  availability target, a five-minute recovery-point objective, and a four-hour
  recovery-time objective in the readiness exercise.
- The owner and at least one member complete the release acceptance script on macOS,
  Windows, and Linux. There are no open critical/high security findings or unresolved
  data-loss defects.

## Pilot review and deferred scope

During the pilot, review weekly: invitation/session failures, send and sync error rates,
event delivery latency, crash-free sessions, search latency, notification outcomes, storage
growth, user-reported data loss, and support volume. After four weeks, use that evidence to
choose whether to expand the product, revise it, or stop; completing M4 does not silently
expand the audience beyond 25 members.

Deferred until a post-pilot decision: multiple workspaces, public signup, guests, private
channels, group DMs, mobile or browser clients, voice/video/screen sharing, presence and
typing indicators, message editing/deletion, custom emoji, bots/apps/webhooks/workflows,
Slack import, enterprise SSO/SCIM, federation, end-to-end encryption, attachment-content
indexing, analytics, retention controls, legal hold, and e-discovery.
