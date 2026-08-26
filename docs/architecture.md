# Architecture implementation contract

This document is the implementation contract for Hype Comms. It distinguishes the current pilot deployment
from the hosted target; a target statement is not evidence that its infrastructure or release gate
exists today. Changes to these invariants require a reviewed architecture change and matching
contract tests.

## Product and platform invariants

- Today there is exactly one hosted workspace and no public registration. One bootstrapped
  owner invites human members by email and provisions bot or agent members through an operator
  CLI; the service rejects a 26th active membership across all three principal kinds.
  Multi-workspace and open signup are deliberate future changes, not emergent ones.
- Channels are either workspace-visible or restricted to an explicit human-or-agent member list.
  Humans see workspace-visible channels automatically. Agents can discover and explicitly join
  them; bots require an explicit grant for every channel. A members-only channel always retains at
  least one channel owner, and only its owners can add, remove, promote, or demote members. A
  one-to-one direct conversation contains one or two distinct participants and is unique for that
  unordered pair. A group direct conversation has 3–25 fixed human-or-agent participants.
- Every channel may own a task project. A self-DM owns the member's personal project and its
  My Tasks view may also include tasks assigned to that member from visible channel projects.
  Ordinary two-person DMs remain chat-only.
- The supported clients are macOS (Apple silicon and Intel), Windows 11 (x64 and ARM64), and
  Linux (x64 and ARM64) AppImage/Debian packages. Electron is currently the only client. Support
  does not require optional capabilities to land simultaneously: feature scope and rollout evidence
  are platform-specific by default. Untargeted
  clients must retain safe existing behavior and shared wire contracts remain compatible.
- Runtime application code is TypeScript: React in the renderer, Electron main/preload on
  desktop, Fastify on the service, and shared strict Zod wire contracts.
- PostgreSQL is authoritative. The desktop cache is disposable, realtime delivery is a
  hint, and a client must be able to rebuild from HTTP APIs without losing its local outbox.
- The target feature set is channels, one-to-one and group DMs, channel and personal task boards, one-level
  threads, emoji reactions, user mentions, unread state, file attachments, message/filename
  search, and native notifications.
- Transport and managed storage are encrypted, but Hype Comms is not end-to-end encrypted.
  The service necessarily processes plaintext for authorization, notifications, malware
  scanning, and search; operators with explicitly granted production access are inside the
  trust boundary.
- IDs are UUIDs generated as UUIDv7 where ordering helps. API timestamps are UTC RFC 3339
  strings. Sequence and byte-count integers cross JSON as decimal strings when they may
  exceed JavaScript's safe integer range.
- The shared Zod package is the source of truth for HTTP, IPC, and realtime wire shapes.
  Reserved schema values such as `editedAt` do not
  imply a reachable behavior today; the server rejects unsupported operations.

### Supported host matrix

This table is the single definition of "that platform's supported OS versions, architectures, and
package formats." Every document that scopes evidence to a platform—the native-notifications
roadmap lanes, `docs/operations.md`, and the Native E2E row below—means this row and nothing
narrower. Changing a platform's baseline is an edit here, not a per-lane judgement call.

| Platform | OS versions                            | Architectures | Package formats  |
| -------- | -------------------------------------- | ------------- | ---------------- |
| macOS    | current and immediately previous major | arm64, x64    | DMG              |
| Windows  | Windows 11                             | x64, ARM64    | NSIS             |
| Linux    | Ubuntu 24.04 LTS                       | x64, ARM64    | AppImage, Debian |

A platform lane covers every cell of its row. Partial coverage—one architecture, one package
format, or one OS version—does not pass that platform's lane and must not be recorded as if it
did.

## System shape and trust boundaries

### Current pilot delivery

```text
main -> Woodpecker check -> Kaniko -> registry.fastnfree.dev/homelab/hype-comms:<commit SHA>
                                                |
reviewed homelab-deploy-kit digest pin -----------+-> Argo CD -> gatorlunch cluster

v* tag -> GitHub Actions native runners -> updates.hypemm.com (S3-compatible storage)
```

The server image build is implemented by `.woodpecker.yml`; it receives no GitOps secret and does
not promote deployments. Runtime manifests, ingress, PostgreSQL, secret injection, backup policy,
and rollback controls live in the separate `hypothetical-money-machine/homelab-deploy-kit`
repository; they must be verified there and cannot
be inferred from this checkout. Desktop releases use disposable GitHub-hosted ARM64 runners and a
public S3-compatible storage-backed generic update feed. See `docs/operations.md` for the current operational contract
and the controls that still need external evidence.

### Hosted target

```text
renderer (React + IndexedDB)
        | validated, allowlisted IPC
preload |-------------------------------- Electron main
                                                | authenticated HTTPS / ticketed WSS
                                                v
Cloudflare DNS/WAF/TLS  --->  AWS ALB  --->  Fastify on ECS Fargate
                                                   |       |       |
                                              PostgreSQL   S3     SES
                                                   |       |
                                            sync/event log  scan worker
```

The packaged client API is `https://chat-api.example.invalid`; realtime uses
`wss://chat-api.example.invalid/v1/realtime`. The email landing page is
`https://chat.hypemm.com/auth/verify`. Stable releases register `hype-comms://auth/callback`.
Local packages default to the separate `Hype Comms DEV` identity and register
`hype-comms-dev://auth/callback`, so both applications can be installed and signed in at once.

The product rebranded from HMM Chat to Hype Comms in two stages. The first stage (July) changed
only user-visible strings. This repository has since completed a second, hard-cutover stage that
renamed every remaining stable technical identifier: the application ID
(`com.hypemm.hypecomms`), the `hype-comms://` protocol, the `@hype-comms/*` package scope,
`HYPE_COMMS_*` environment variables,
the `X-Hype-Comms-Capabilities` header, session cookie, token prefixes, and cache/database names.
That migration was a one-time, self-hosted-only cutover: existing sessions and issued
agent/bot tokens were invalidated, and installed desktop clients required one manual reinstall
because the application ID change breaks auto-update continuity. There is no ongoing freeze on
these identifiers; future renames are an ordinary versioned change like any other, evaluated for
their own compatibility impact when proposed.

| Component      | Responsibility                                                                                                                                                       | Must not do                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Electron main  | Window lifecycle, native appearance and local preferences, session/token storage, authenticated HTTP/WSS, deep links, cache cryptography, notifications, and updates | Render remote content or expose tokens, raw filesystem, shell, arbitrary CSS, or network calls to the renderer            |
| Preload        | Frozen, typed, request/response IPC facade with runtime validation and unsubscribe handles                                                                           | Pass through arbitrary channel names, URLs, headers, or Electron objects                                                  |
| Renderer       | React UI, semantic theme rendering, normalized state, renderer-owned IndexedDB cache/outbox, optimistic state, and routing behind a transport interface              | Import Node/Electron, receive credentials, connect to production origins directly, or treat cache/events as authoritative |
| Fastify        | Authentication, authorization, validation, business transactions, search, sync, signed URL issuance, and WebSocket fanout                                            | Trust client workspace/user IDs or use WebSocket delivery as durable state                                                |
| PostgreSQL     | Canonical domain state, idempotency records, read cursors, search vectors, and ordered sync events                                                                   | Store raw magic-link/refresh tokens or public object URLs                                                                 |
| S3/scan worker | Private quarantine and clean attachment/update objects; asynchronous malware verdicts                                                                                | Make an upload downloadable before a clean verdict                                                                        |

The hosted target follows the organization's AWS+Cloudflare convention: a versioned
CloudFormation entry stack at `deploy/poc/stack.yml`, with nested stacks and small scripts
only where a
Cloudflare or release operation cannot be expressed in a stack. GitHub OIDC assumes the
deployment role. Production runs two stateless Fastify tasks across availability zones
behind an ALB, an encrypted Multi-AZ RDS PostgreSQL instance in private subnets, private
versioned S3 buckets, SES, KMS, Secrets Manager, and CloudWatch. Cloudflare proxies
API/WebSocket traffic with Full (strict) TLS, WAF, and rate limiting; the origin accepts only
authenticated Cloudflare/operations traffic. No Redis or separate search cluster is needed
at the current 25-member scale.

## Domain and persistence contract

| Aggregate              | Current rules                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace              | One provisioned row. Name/slug are admin configuration, not user-created data. Agent enrollment policy is an explicit persisted `required` or `automatic` value, defaults to `required`, and is never inferred from the name or slug.                                                                                                                                                            |
| User and membership    | A user is `human`, `bot`, or `agent`. Human email is normalized for comparison and unique; bots and agents have no email and cannot create device sessions. A membership is `owner` or `member` and `invited`, `active`, or `revoked`; bots and agents are always members. Capacity counts every active principal transactionally. Usernames are stable, unique lowercase mention handles; display names may change.                                                          |
| Invitation and session | Invitations are email-bound, owner-created, single-workspace, and expire after seven days. Magic-link challenges are single-use and expire after 15 minutes. Optional AuthKit uses a ten-minute encrypted provider transaction and a five-minute desktop-PKCE handoff; verified provider identity still passes local invite admission. Both methods create the same rotating, revocable local device session, and only credential hashes plus the upstream session ID needed for revocation are retained. |
| Bot credential         | Owner-issued service credential with one or both `tasks:read` and `tasks:write` scopes, a required expiry, last-used time, and optional revocation time. The 256-bit token is shown once and only its SHA-256 hash is stored. Rotation atomically revokes every prior credential for that bot.                                                                                                        |
| Bot channel grant      | Explicit bot-to-channel authorization. A grant is required even when the channel access mode is `workspace`; it never grants a DM. Visibility is the intersection of an active bot membership, credential scope, and channel grant.                                                                                                                                                              |
| Agent credential       | Non-expiring bearer credential with immutable scopes. Credentials may select `workspace:read`, `messages:write`, legacy `conversations:write`, `read-cursors:write`, `direct-conversations:write`, `channels:join`, `agents:invite`, and/or explicit `attachments:write`. Enrollment fixes `default-agency-v1` to `workspace:read`, `messages:write`, `direct-conversations:write`, `channels:join`, and `agents:invite`; it deliberately omits attachment writes. Only a SHA-256 credential hash is stored; disabling an agent revokes its active membership and every token. |
| Agent enrollment       | A child generates its final 256-bit credential locally and offers only its SHA-256 verifier. Its private profile retains the immutable pending offer for exact output recovery until authenticated redemption clears the marker. An authorized inviter binds that verifier to an immutable identity, label, and restricted-channel seat set. Policy produces `pending_approval` or `ready_to_redeem`; redemption rechecks requester authority, seats, expiry, capacity, username and credential uniqueness, then atomically creates the agent/token. Every transition is audited without plaintext credentials. |
| Conversation           | `channel` has a unique normalized slug and an access mode: `workspace` is readable by every active human and by agents with an active conversation seat, while `members` always requires an active human or agent seat. Agents may discover and self-join active public channels; private channels require an invitation. Task-only bots use explicit grants for either mode. Members-only channels have `owner` and `member` roles and must retain an owner. `direct_message` has a unique sorted human-or-agent pair; `group_direct_message` has fixed active human-or-agent membership. Archived channels remain readable to existing audiences but reject writes and joins. |
| Message                | Immutable record (editing and deletion are deferred) with a 1–4,000 character UTF-8 body, monotonically assigned per-conversation sequence, stable `clientMessageId`, author, and optional thread root. A reply points directly to a top-level message in the same conversation; replies to replies are rejected.                                                                                 |
| Mention                | Create-message input includes explicit mentioned user IDs and plain-text `@username` tokens. The server verifies active membership and matching stable handles, then stores a join row; raw text parsing is never used for notification authorization. Maximum 50 distinct mentions per message.                                                                                                  |
| Reaction               | Unicode emoji normalized to NFC; one row per message/member/emoji, at most 20 per member and 250 total per message. Add and remove are idempotent. Custom emoji are unsupported.                                                                                                                                                                                                                  |
| Read cursor            | One per member/conversation, represented externally by a message ID and internally by its conversation sequence. Updates only move forward. Counts exclude the reader's own messages; mention counts are tracked separately. Read events are visible only to that member, so there are no read receipts.                                                                                          |
| Task                   | Belongs to one channel or self-DM and has a conversation-local number, optimistic version, title, optional description/assignee/due date/source message, priority, fixed `todo`/`in_progress`/`done` status, canonical integer rank within a status column, and latest-mutation actor. Completing sets `completedAt`; reopening clears it. Assignees and linked messages must be able to access the same conversation. |
| Attachment             | Maximum 25 MiB, sanitized display filename, detected MIME type, immutable object key, size/hash, and `pending`, `ready`, or `failed` scan status. The pilot keeps object bytes on its attachment PVC; private S3 plus a scan worker belongs to the hosted target. An attachment is staged without a message, then associated exactly once when a message is created. Executables are rejected. A message may reference at most ten ready attachments. `attachments-v1` negotiates wire projections only; `workspace:read` plus conversation visibility authorizes agent reads from live messages. Upload, byte write, completion, and attachment claiming require explicit `attachments:write` for an agent credential. |
| Sync event             | Immutable versioned envelope with a workspace-global sequence, audience, optional conversation, actor, entity payload, and occurrence time. Events are retained for 90 days.                                                                                                                                                                                                                      |

Domain mutations, their idempotency result, and corresponding sync events commit in one
database transaction. A per-workspace sequence provides a total event order; message order
inside a conversation uses a separate sequence allocated in that same transaction.
PostgreSQL `LISTEN/NOTIFY` only wakes API replicas to read newly committed event rows. Lost
notifications are harmless because replicas and reconnecting clients resume from the event
log.

Important constraints are enforced in PostgreSQL as well as application code: one DM per
sorted member pair; one reaction per member/message/emoji; one message per
author/`clientMessageId`; one task number per conversation; monotonic read cursors; unique active
email/username/channel slug; and task/message/attachment/thread references within the same
authorized conversation. Every query for history, tasks, sync, search, files, or events applies
conversation visibility on the server; knowledge of an ID never grants access.

Membership mutations lock the channel row to serialize competing owner changes, then reject a
removal or demotion that would leave a members-only channel without an owner.

Search uses a stored `tsvector` over the flattened message body with a GIN index and
`websearch_to_tsquery`. Results are ranked, then ordered by committed workspace sequence plus ID
for stable cursor pagination. Each opaque cursor is bound to the normalized query and rejects sort
keys outside PostgreSQL's `real`/`bigint` ranges. Ready attachment filenames join that vector when
attachments ship; search never inspects file contents, pending/failed files, or inaccessible
conversations.

## HTTP and realtime interface

All product endpoints are under `/v1`, accept and return JSON unless transferring directly
to S3, and are validated by shared strict schemas. Success responses contain canonical
entities and the committed sync cursor where applicable. Errors use
`{ error: { code, message, requestId, details? } }`; production messages are safe for users
and never include stack traces, SQL, tokens, email-existence hints, or object keys.

Collection pagination uses opaque `before`/`after` cursors, defaults to 50 items, and caps at 100. Mutation requests carry `Idempotency-Key`; create-message additionally carries the same
UUID as `clientMessageId`. A replay with the same authenticated actor, route, key, and body
returns the original result. Reuse with a different fingerprint returns `409 CONFLICT`.

Task lists additionally filter by one status, priority, assignee (`me`, `unassigned`, or user ID),
inclusive due-date range, exclusive update timestamp, and latest actor (`me` or user ID). Their
opaque cursors are bound to that exact filter set; changing filters requires a fresh first page.

| Route                                                                         | Contract                                                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /livez`, `GET /readyz`                                                   | Process liveness and dependency readiness; no sensitive diagnostic data.                                                                  |
| `GET /v1/auth/capabilities`                                                   | Discover the additive AuthKit and self-service magic-link methods without exposing configuration.                                         |
| `POST /v1/auth/magic-link`                                                    | Uniformly accept an invited/active email when self-service delivery is enabled; never reveal membership.                                  |
| `POST /v1/auth/desktop-authorizations`, `GET /v1/auth/workos/callback`        | Start dual-PKCE AuthKit in the system browser, then return a credential-free Hype Comms handoff to the fixed desktop scheme.              |
| `POST /v1/auth/exchange`                                                      | Exchange a five-minute desktop-PKCE handoff once, set the existing HttpOnly `hype_comms_session` cookie, and return the current local user.       |
| `POST /v1/auth/session/refresh`, `DELETE /v1/auth/session`                    | Rotate the local device credential or revoke the current device session.                                                                  |
| `POST /v1/auth/workos/webhook`                                                | Verify the exact signed raw WorkOS event and idempotently apply upstream session revocation.                                               |
| `GET /v1/sessions`, `DELETE /v1/sessions/:id`                                 | List and revoke the caller's other device sessions.                                                                                       |
| `GET /v1/bootstrap`                                                           | Current user/workspace, active members, conversation summaries, read state, feature flags, and current sync cursor; no unbounded history. |
| `GET /v1/members`                                                             | Active member directory for DMs and mention completion.                                                                                   |
| `GET /v1/invitations`, `POST /v1/invitations`, `DELETE /v1/invitations/:id`   | Owner-only list/create/revoke; enforce normalized-email uniqueness, expiry, and capacity.                                                 |
| `GET/POST /v1/agents`, `DELETE /v1/agents/:id`                                | Owner-only list/create/disable for non-email agent members; active agents share workspace capacity with people and bots.                  |
| `GET/POST /v1/agents/:id/tokens`, `DELETE .../:tokenId`                       | Owner-only list/create/revoke for one-time agent tokens; metadata never returns plaintext or token hashes.                                |
| `GET/PATCH /v1/agent-enrollment-policy`                                      | Owner-only read/update of the explicit `required` or `automatic` workspace policy; new workspaces default to `required`.                  |
| `POST /v1/agent-enrollments`, `GET /v1/agent-enrollments[/:id]`               | An owner or agent with `agents:invite` requests and reads its enrollments; owners can read the workspace queue. Requests are idempotent and carry a child-generated verifier, immutable identity, label, and restricted-channel seats. |
| `POST /v1/agent-enrollments/:id/review`, `POST .../:id/cancel`                 | An owner approves/rejects; an owner or original requester cancels an open enrollment. State transitions are bounded and audited.          |
| `POST /v1/agent-enrollments/:id/redeem`                                       | The unauthenticated child proves possession through the enrollment authorization scheme; activation is atomic and returns no credential. |
| `GET /v1/conversations`, `POST /v1/channels`, `PATCH /v1/channels/:id`        | List visible summaries, create a workspace-visible or members-only channel, or archive a visible channel as workspace owner.              |
| `GET /v1/channels`, `PUT /v1/channels/:id/membership`                         | Page discoverable public-channel metadata or idempotently self-join one active public channel; private and archived channels remain hidden. |
| `GET /v1/channels/:id/members`, `PUT/DELETE /v1/channels/:id/members/:userId` | List a visible channel's audience or, for a members-only channel owner, add, remove, promote, or demote one active workspace member.      |
| `POST /v1/direct-conversations`                                               | Return the existing DM for `memberId` or atomically create it. A `workspace:read` agent may reopen its existing DM; creation requires narrow `direct-conversations:write` or legacy `conversations:write`. |
| `POST /v1/group-direct-conversations`                                         | Idempotently create a fixed-membership group for the caller plus 2–24 distinct active human or agent members in the same workspace.       |
| `GET /v1/conversations/:id/messages`                                          | Authorized, reverse-chronological history pagination rendered oldest-first. `agent-context-pack-v1` adds a bounded, anchored agent projection without changing the legacy shape. |
| `POST /v1/conversations/:id/messages`                                         | Create a top-level message or reply (`threadRootId`), mentioned member IDs, and ready attachment IDs. Requires stable `clientMessageId`; agent attachment IDs additionally require `attachments:write`. |
| `GET /v1/messages/:id/thread`                                                 | Root plus paginated replies, authorized through the parent conversation; agents require `workspace:read`.                                 |
| `POST /v1/reactions/query`                                                    | Return reactions for up to 100 authorized message IDs without changing the strict history response.                                       |
| `PUT /v1/messages/:id/reactions/:emoji`, `DELETE ...`                         | Idempotently add/remove the caller's normalized Unicode reaction.                                                                         |
| `PUT /v1/conversations/:id/read-cursor`                                       | Advance through `lastReadMessageId`; never move backward.                                                                                 |
| `GET/POST /v1/conversations/:id/tasks`                                        | Page a channel/self-DM project or idempotently add its next numbered task. Human cookies or channel-granted bot bearer credentials with the matching task scope are accepted. |
| `GET/POST /v1/channels/:slug/tasks`, `GET /v1/channels/:slug/tasks/:number`    | Bot-friendly channel aliases for filtered board listing, idempotent creation, and stable lookup by the channel-local task number.          |
| `GET /v1/tasks/mine`                                                          | Page the caller's personal tasks plus assigned tasks from currently visible, non-archived channels. For a bot, this means assigned tasks in explicitly granted channels. |
| `GET /v1/tasks/:id`                                                           | Return one authorized canonical task by UUID without scanning its board.                                                                  |
| `PATCH /v1/tasks/:id`, `POST /v1/tasks/:id/move`                              | Idempotently edit fields or move/reorder a task with an expected entity version. Bot callers require `tasks:write`.                       |
| `POST /v1/files/uploads`, `PUT /v1/files/:id/content`, `POST .../:id/complete` | Create a 15-minute quarantine upload, write its bytes, and confirm hash/size. Agent credentials require explicit `attachments:write`.     |
| `GET /v1/files/:id/download`                                                  | For an authorized ready file, return a five-minute signed download URL.                                                                   |
| `GET /v1/conversations/:id/files`, `POST /v1/attachments/query`               | List ready files in one visible conversation or for bounded visible message IDs; agents require `workspace:read`. `attachments-v1` affects shape, not authority. |
| `GET /v1/files/:id/content`                                                   | Stream one ready, visible attachment with bounded length and a SHA-256 response header for non-desktop clients; agents require `workspace:read`. |
| `GET /v1/search`                                                              | Query authorized message text with ranked opaque-cursor pagination.                                                                       |
| `GET /v1/sync?after=...`                                                      | Return authorized events, next scanned cursor, high-water cursor, and `hasMore`; `410 CURSOR_EXPIRED` requires bootstrap.                 |
| `POST /v1/realtime/tickets`                                                   | Issue a single-use 30-second ticket bound to the human device session or agent token for a WSS connection; never return the access credential. |
| `GET /v1/desktop/releases/latest`                                             | Authenticated metadata for the caller's platform/architecture and a short-lived signed artifact URL.                                      |

The app requests a magic link only after generating a verifier and challenge. The emailed
HTTPS URL lands at `https://chat.hypemm.com/auth/verify`, consumes the hashed single-use
token, and redirects to `hype-comms://auth/callback?code=...`; that code expires after 60
seconds and is useless without the verifier retained by the requesting app. If the app is
not installed, the landing page gives signed installer links and instructions without
creating a browser session. The first owner invitation is created by a one-time deployment
command, not by a permanent unauthenticated endpoint. Cloudflare routes only this landing
path to Fastify's verification handler; the page does not store a cookie, token, or chat
state.

Main obtains a single-use realtime ticket over authenticated HTTP, then opens
`wss://chat-api.example.invalid/v1/realtime?ticket=...&after=...`. The ticket expires after 30
seconds, is stored only as a hash, is consumed atomically during upgrade, and is bound to the
issuing member/device session. Bearer and refresh credentials never appear in WebSocket
headers, URLs, or subprotocols. The server first replays authorized retained events after
the cursor, then switches the same connection to live delivery without a race. It sends
30-second heartbeats and closes stale connections. The client reconnects with exponential
full jitter from 500 ms to 30 seconds and obtains a fresh ticket for every attempt. WebSocket
control frames include `system.connected`, `system.resync_required`, and `system.error`;
domain events are:

- `member.updated`, `channel.created`, `channel.membership_changed`, and
  `direct_conversation.created`;
- `message.created`, `reaction.added`, and `reaction.removed`;
- `task.created` and `task.updated`;
- `read_cursor.updated` (the owning member only); and
- `attachment.ready` or `attachment.failed` (only the uploader and conversation audience
  once attached).

Before `system.connected` proves the ticket's exact user scope, desktop main buffers at most 1,024
validated replay events and 4 MiB of serialized frames; each WebSocket frame is also capped at
4 MiB. Overflow drops the message-bearing buffer, stops that connection generation without a
same-cursor reconnect, and retains only a body-free, scope-bound resync control until renderer HTTP
recovery supplies a newer durable cursor. A renderer navigation or crash similarly pauses event
delivery at the last acknowledged cursor. Shared event schemas also verify canonical cross-field
relations—such as message conversation/sequence/version and task workspace/conversation/version—
for both WebSocket and HTTP sync before either path can reach the encrypted replica.

Reaction, task, and read-state events are capability-gated for rolling compatibility. A client
advertises `reaction-events-v1`, `task-events-v1`, and `read-state-events-v1` through
`X-Hype-Comms-Capabilities` on both
`GET /v1/sync` and `POST /v1/realtime/tickets`. Clients without a capability do not receive its
events, but the server still advances their scanned cursor past those events so released clients
neither fail strict parsing nor loop on an unsupported event.

Thread summaries are capability-gated separately because conversation-history responses are
strict. A current client advertises `threads-v1` on
`GET /v1/conversations/:id/messages`; the server then adds bounded reply-count and latest-reply
metadata for the roots in that page and sets `threadsSupported: true`. Without the capability the
server returns the previous exact history shape, stripping both the summaries and support flag,
and continues paginating replies inline. Current clients default an absent summary collection and
an absent `threadsSupported` flag to empty and `false`, respectively, so a rolled-back or
immediately previous server remains readable and can be distinguished during a rolling upgrade.

Group direct messages use a separate `group-direct-messages-v1` capability because the immediately
previous desktop could mistake a group for a one-to-one conversation and conceal recipients. For a
client without that capability, conversation lists and message search exclude groups in SQL before
applying `LIMIT`, so hidden rows cannot create empty middle pages or starve later visible results.
HTTP sync and realtime use the same rule: group events are not delivered, but each scanned event
still advances the client's cursor. An older client may continue using unrelated workspace routes;
if it presents a known group conversation, message, or file ID to a group-aware route, the server
returns an update-required conflict before any mutation. Normal authorization and resource-state
checks still run first where necessary, so this response cannot reveal a retracted message or
another participant's staged file.

Every domain envelope adds `cursor`, `version`, event ID/type, occurrence time, workspace
and optional conversation IDs, and a typed payload. Workspace-channel events target active
workspace members; members-only channel events target active channel members. Membership
changes target the union of the old and new audience so a removed member can purge the channel
immediately. One-to-one events target their one or two fixed participants. Group direct-message
events target their fixed three-to-25-person participant set; inactive participants remain in the
historical roster but stop receiving new events. A global cursor may therefore contain gaps for a
client. Sync advances to the server's scanned cursor rather than the last visible event so a client
cannot loop on hidden events. Event payloads never contain access tokens, email magic links,
refresh credentials, presigned object URLs, or file object keys.

## Desktop cache, outbox, and convergence

The renderer owns a Dexie-backed IndexedDB adapter so the application state layer remains
browser-portable and avoids native database rebuilds. UI code depends on a typed transport
interface; its Electron implementation is validated IPC to main, while a future browser
implementation could supply `fetch`/WebSocket without changing stores or views. The
renderer does not get direct production-network access.

Only routing and ordering metadata (entity IDs, conversation IDs, timestamps,
sequence/cursor, record version, and outbox status) is cleartext in IndexedDB. Message
bodies, reaction emoji, task titles/descriptions/dates, member/workspace display data, attachment
metadata, and queued mutation payloads are encrypted as AES-256-GCM values with a fresh nonce and
store/key/schema version as authenticated additional data.

Electron main generates the cache data key, wraps it with `safeStorage`, and exposes only
bounded, validated batch encrypt/decrypt IPC. The raw key never crosses preload. On macOS
and Windows this uses the OS credential store; Linux packages require Secret Service backed
by a real keyring and reject Electron's `basic_text` backend. If safe encryption is not
available, the client uses a clearly labeled memory-only cache/outbox for that session. A
logout or revoked session deletes IndexedDB and the wrapped key. Logout with pending sends
requires explicit confirmation. A missing key or authentication-tag failure stops cache use
and presents an explicit recovery/reset choice instead of silently dropping an outbox.

The persistent cache retains at most the newest 90 days or 20,000 acknowledged messages,
whichever is smaller. Reactions are evicted with their message; eviction never touches outbox
entries. Older history remains available from the server while online. File bytes are not
persisted in IndexedDB; main-managed
temporary downloads are removed on logout and on the next startup. Offline full-text search
and offline attachment uploads are deferred: queued sends contain text, mentions, and thread
context only, and the UI requires connectivity before attaching a file.

A full snapshot replacement authoritatively pages task boards for every visible channel and the
signed-in person's self DM; peer and group DMs are not task targets and are never queried. The
aggregate replacement is capped at 20,000 tasks. Inconsistent or cyclic pagination, duplicate task
IDs, crossed workspace/conversation scope, or capacity overflow fails the entire replacement before
its bootstrap high-water cursor is committed, so cached task state is never silently retained or
partially advanced past.

Renderer startup and authoritative recovery use this sequence. An ordinary socket reconnect resumes
from the last durable acknowledgement without rebuilding the snapshot:

1. Render decrypted cache with an explicit stale/offline state while main restores a session.
2. When an encrypted replica exists, page `/sync` from its durable cursor and apply that catch-up
   before replacing the snapshot. This repairs any interval main observed while macOS had no
   renderer without treating notification progress as UI progress.
3. Build an authoritative snapshot from bootstrap plus every conversation, history, reaction,
   and eligible task page, then commit it atomically at the bootstrap high-water cursor.
4. Page `/sync` again from that committed cursor until its current high-water cursor.
5. Obtain a realtime ticket and connect with the last durably applied cursor; the server
   replays the connection gap.
6. For each event, validate its version/audience, apply an idempotent entity upsert/delete and
   cursor advance in one IndexedDB transaction, then update visible state.
7. Once membership/conversation state is current, flush the outbox FIFO within each
   conversation and with at most three conversations in flight.

Duplicate event IDs are ignored, older entity versions cannot overwrite newer data, and a
cursor is advanced only after durable application. On `CURSOR_EXPIRED`, preserve the
outbox, replace server-derived cache stores from bootstrap/history, and resume. An unknown
event version pauses cursor advancement, records a redacted diagnostic, and requires a
compatible app update or full resync; it is never skipped.

A channel-membership event refreshes the authoritative visible-conversation snapshot instead of
trying to infer access locally. If the current member was removed, that refresh deletes the
channel summary and acknowledged history from the cache, preserves unrelated outbox entries, and
moves selection to the first remaining visible conversation.

Each queued send stores one generated UUID as both `clientMessageId` and idempotency key.
The optimistic row is reconciled by that ID, not by body or timestamp. Network errors,
timeouts, `429`, and `5xx` retry with full jitter (one second to 30 seconds) and honor
`Retry-After`; `401` attempts one token refresh and then pauses for login. Validation,
authorization, missing-conversation, oversized, and idempotency-fingerprint errors are
permanent and remain visible with edit/retry/discard actions. A permanent failure blocks
later sends in that conversation until the user resolves it, preserving authored order.
Server uniqueness on author plus `clientMessageId` is permanent, so a retry after local or
server restart cannot create a duplicate. Editing a failed queued payload discards its old
key and creates a new client message/key; changed content never reuses an accepted key.

Task reads and realtime projections are available from the encrypted cache while offline. Task
creates, edits, and Kanban moves currently require connectivity and are not placed in the message
outbox; every online mutation is idempotent and uses an expected task version so concurrent edits
surface as a conflict instead of silently overwriting another device.

Unread state is server-authoritative. A focused conversation advances only through the
newest message actually rendered, never blindly to the server head; the API applies
`greatest(existing, submitted)`. All non-self messages, including thread replies, contribute
to conversation unread count, while explicit mentions have a separate count. Sending a
message does not mark unseen incoming messages as read. Read-cursor sync across a user's
devices is private to that user.

## Desktop appearance contract

Appearance is an app/profile-local design combining a preference for `system` or one registered
built-in theme ID with an optional accent color. The current built-ins are `light` and `dark`; the
selector is generated from the ordered theme registry, and a null accent preserves the exact
bundled appearance. Electron main owns its strict, versioned file under `userData`; version 2 stores
the preference and accent atomically, while a valid version-1 preference is migrated in memory as
an accent-free design. Main applies the built-in foundation's light/dark color scheme to
`nativeTheme` before creating a window and keeps the native window background synchronized. Missing,
malformed, or unregistered data falls back to the accent-free `system` design; a failed write leaves
the last canonical state unchanged. Sign-out does not clear this non-secret device preference.

IPC carries only the validated preference, resolved theme ID, resolved light/dark scheme, and a
nullable six-digit hexadecimal accent seed. It never carries arbitrary CSS or presentation-token
values. The shared theme module maps that state to one bundled theme definition and, when an accent
is present, derives twelve fixed semantic roles for highlights, accent text, borders, primary
actions, focus, accent surfaces, and brand gradients. Trusted templates generate every rgba and
gradient value; contrast correction keeps both accent text roles at 4.5:1 on their opaque and
composited surfaces, primary-action text at 4.5:1, primary controls and border accents at 3:1
against adjacent surfaces, and brand text at 4.5:1.
The complete semantic-token contract still covers surfaces, text hierarchy, borders, actions,
status colors, focus, elevation, brand effects, and scrollbars. Theme identity is independent from
its light/dark color scheme, so multiple named themes may share a native scheme. Component CSS
consumes only those semantic variables. Tokens are installed on the document root so ordinary views
and body-level portals inherit the same theme.

The current dark appearance is the reference theme and light is a fully defined peer. A new named
theme becomes selectable by adding one complete validated definition to the registry; its label,
tokens, color scheme, and native window background travel together. Main passes its exact
initialized state, including the bounded accent seed, to the sandboxed preload as a validated,
non-secret renderer argument, so the designed theme paints correctly before React mounts. Theme
state is subscribed before hydration so a stale startup response cannot replace a newer native
update. `system` follows operating-system appearance changes live while preserving the accent;
explicit built-in choices remain fixed. Every theme must meet the tested
text/action/status/control contrast pairs and use the shared focus treatment before it can be added
to the built-in registry.

An explicit Electron `nativeTheme.themeSource` also overrides renderer color-scheme media queries,
so the theme designer cannot infer the operating-system foundation from renderer state. Its System
preview uses a separate trusted, read-only IPC request. Main serializes that request with appearance
writes, temporarily removes the explicit native override to sample the OS scheme, restores the
canonical active source, and returns a validated System state without persisting or publishing it.
The renderer scopes that result to the draft preview. Before saving a System draft over an explicit
active theme, it resolves the OS foundation again; if the result changed, the designer refreshes
the preview and requires another explicit save instead of applying an appearance the user did not
review.

## Feature behavior

- Channel names use a unique lowercase hyphenated slug; all active members can create either a
  workspace channel or a members-only channel. The creator owns a members-only channel, owners
  manage its member/owner roles, and the final owner cannot be removed or demoted. `general` is
  provisioned workspace-wide and cannot be archived.
- Creating a DM is symmetric and returns the existing conversation for the member pair.
  Revoking either member immediately blocks new reads/writes and event delivery to that
  device after session invalidation.
- Threads have exactly one root and one reply level. A root history item carries reply count
  and latest-reply metadata; full replies are fetched from the thread endpoint.
- Mention completion uses the active member directory and inserts stable `@username` text
  plus the user ID. Notifications and mention counts use the verified join rows, not regex
  parsing. Plain URLs may be linkified; arbitrary rich text/HTML is never rendered.
- Search covers message bodies in every channel and DM visible at request time. Results use
  PostgreSQL full-text ranking and stable cursor pagination; selecting one opens the conversation,
  inserts an older hit into the cached timeline when needed, and highlights it.
- Reactions are grouped by emoji beneath each main-timeline message. The quick picker toggles the
  current member's reaction, archived conversations expose reactions read-only, history pages
  batch-hydrate current state, and capability-gated sync/realtime events converge other devices.
- Channels expose Chat and Tasks panes, with Board as the default task view and List as an option.
  The Board has fixed To do, In progress, and Done columns with canonical drag/drop and keyboard
  reordering. A message can create a source-linked task. The self-DM defaults to My Tasks in List
  mode and can include work assigned from visible channel boards.
- Upload URLs accept one exact content length/type/checksum into an S3 quarantine prefix.
  Completion enqueues an isolated scanner; only a clean verdict atomically changes status
  to ready and emits an event. EICAR/unknown executable content becomes failed, is deleted,
  and is never served. Pending objects older than 24 hours are deleted.
- Search returns a body snippet with escaped highlights but no durable download URL. Empty,
  stop-word-only, and overly broad queries return a validated user error; queries are
  limited to 200 characters and 30 per minute per member.
- Native notifications follow the main/renderer, freshness, and action boundaries described here.
  Milestones 0 through 3 are implemented and
  covered deterministically, including direct messages, verified mentions, and the
  capability-gated recipient-specific `participated_thread_reply` reason. Main applies precedence
  in that order: verified mention, direct message, then participated-thread reply. It never infers
  participation from local thread state.
- The implementation is compiled off unless the build-time
  `HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED=1` switch is explicit; unset and `0` fail closed, and the
  device preference also defaults disabled. Notification bookkeeping is ephemeral and never
  advances or delays the renderer replica, sync cursor, read cursor, unread count, or mention
  count.
- Once explicitly enabled, main evaluates only a fresh `message.created` from the connection armed
  by its validated `system.connected`. Replay, catch-up, duplicates, null/self authors, focus, an
  exact stream visible at its live tail, stale scope, disabled/unsupported capability, and OS
  denial are quiet. Human, bot, and agent authors follow the same policy. Group direct messages
  use the same direct-message eligibility, with verified mentions still taking precedence.
- In a flag-enabled macOS build, closing the last window keeps only notification observation on the
  authenticated realtime connection. That path sends no renderer event, buffers no UI event, and
  cannot advance the renderer cursor. A recreated renderer catches up from the encrypted replica
  cursor, commits the authoritative snapshot and final HTTP sync, then opens a new realtime epoch.
  A windowless `system.resync_required` stops and latches body-free recovery until that renderer
  supplies a strictly newer durable cursor. Default-off builds retain last-window realtime stop;
  Windows and Linux stop realtime and quit after the last window closes. The
  [main transport](../apps/desktop/src/main/workspace-realtime.test.ts) and
  [renderer recovery](../apps/desktop/src/renderer/src/workspace-runtime.test.ts) suites prove this
  separation.
- Notification content defaults to bounded author/conversation metadata, never message body text.
  A body-free, scope-bound click action restores the exact conversation/message/thread only in its
  originating process and current session generation. Main retains delivery until an exact
  post-navigation renderer acknowledgement, so reloads re-drain safely without repeating handled
  navigation. Denial or presenter failure is a stable local state, not a prompt/retry/reconnect
  loop; a fully quit desktop receives no push. Headless automation uses a body-free opaque-ID
  capture/activation path and never constructs a native presenter.
- On Windows, main sets the selected Electron Builder AppUserModelID before creating a
  `BrowserWindow`: `com.hypemm.hypecomms` for production and `com.hypemm.hypecomms.dev` for DEV. A
  [deterministic identity test](../apps/desktop/src/main/application-identity.test.ts) prevents
  source/package drift. Stable installed NSIS attribution and click handling remain part of the
  native evidence gate.
- Installed synthetic notification evidence is committed for one signed/notarized macOS ARM64 run:
  the [OS toast](screenshots/macos-native-notification-toast.png) and
  [restored-window callback](screenshots/macos-native-notification-click-through.png). The macOS
  release artifact includes the controller as an opt-in pilot while its device preference remains
  disabled by default; Windows and Linux release artifacts remain compiled off. Milestone 4 is
  evaluated per platform, so one platform can
  advance after every cell of its [supported host matrix](#supported-host-matrix) row passes without
  weakening another's gate. Ordinary package smoke only verifies build contents. Its separate,
  manually dispatched macOS evidence lane signs, installs, launches, displays, captures, and clicks
  a synthetic native toast on an unlocked host.

## Security, privacy, and operations

### Desktop and authentication

Every `BrowserWindow` disables Node integration, enables context isolation, sandboxing, and
web security, and uses a fixed local preload. Navigation and new windows are denied;
allowlisted `https:` links open in the system browser after URL validation, and validated
RFC 6068 `mailto:` links open the operating system's mail composer through the same
single main-process handoff; every other scheme is dropped. The production
CSP defaults to `default-src 'self'`, forbids object/embed content and inline/eval scripts,
and sets `connect-src 'self'` because only main performs product networking. Remote renderer
code, Electron `remote`, arbitrary IPC, shell execution, and generic filesystem/network
bridges are prohibited. IPC schemas, sender frame/origin checks, payload size limits, and one
registration/cleanup path are mandatory.

All authenticated HTTP and WSS setup originates in main; renderer calls the transport
interface through preload and never sees an access credential or realtime ticket. Access
credentials expire after 15 minutes. Opaque 30-day refresh credentials rotate on every use;
reuse revokes the device-session family. Tokens are random 256-bit values, stored as keyed
hashes server-side, and scoped to one user, workspace, and device session.
Membership/session status is checked on every authorized request and ticket redemption, so
invitation revocation, member removal, and session revocation take effect immediately.

The current pilot's optional WorkOS AuthKit path is additive to that local session boundary. Main
creates and protects desktop state plus an S256 verifier; the server independently creates a
WorkOS PKCE transaction and keeps its verifier encrypted with AES-256-GCM. WorkOS returns only to
the fixed server callback. The server consumes state before code exchange, verifies the RS256
access JWT against WorkOS JWKS and this Application's exact `client_id`, rejects unverified email
and impersonation, discards upstream tokens, and applies the existing local invitation/capacity
transaction. A fresh five-minute Hype Comms handoff is bound to desktop PKCE and is the only code
sent through the callback selected at transaction creation: `hype-comms://auth/callback` for the
omitted or production variant, and `hype-comms-dev://auth/callback` for development. A one-use
handoff creates the same `hype_comms_session` cookie and device-session lineage as magic-link
sign-in; protected routes, realtime tickets, cache scopes, and rolling clients therefore keep one
authorization model.

Only stable `(provider, subject) -> local user` ownership, the last verified email, and the WorkOS
session ID needed for active-session enforcement survive admission. Signed, raw-body-verified
`session.revoked` webhooks are deduplicated by event ID and revoke matching local device sessions;
the exchange and webhook serialize on the upstream session ID so a revocation racing a handoff
cannot create a live local session. Startup and hourly reconciliation strictly paginate the
complete active WorkOS session set for each relevant subject and revoke only exact local snapshot
rows missing upstream. Incomplete provider state preserves local rows for a later retry, while a
new session cannot be revoked from an older snapshot. Provider session links are cleared on local
revocation or expiry, and provider-independent maintenance removes expired encrypted state even
after provider-secret loss. AuthKit validity alone never grants workspace access.

Agent bearer credentials are accepted only by agent-capable identity and workspace routes. Every
request checks the token hash, token revocation, active agent membership, and the route's immutable
scope. An agent reads and posts only in conversations where it is a participant: it may discover
and join active public channels with `channels:join`, while private channels require an invitation.
It may open one-to-one or fixed-membership group conversations with
`direct-conversations:write` (or the broader legacy `conversations:write`), send and explicitly
identify mentions with `messages:write`, and advance its cursor with `read-cursors:write`. Mentions
never add a participant. `agents:invite` permits only an enrollment request and the requester's own
status/cancellation; policy, review, legacy agent creation, and token administration remain
owner-only. The enrolled `default-agency-v1` profile contains exactly `workspace:read`,
`messages:write`, `direct-conversations:write`, `channels:join`, and `agents:invite`.
`attachments:write` is deliberately outside that default: the default can read files attached to
accessible, non-retracted messages but cannot upload or attach bytes. Supplying both a human cookie
and agent bearer credential to an identity route is rejected as ambiguous. Agent tokens never cross
the renderer boundary or appear in argv, URLs, logs, or realtime tickets.

Enrollment is a claim protocol, not token delivery. The child stores the final credential locally
before exposing its SHA-256 verifier; the inviter and owner see only the verifier-bound request, and
the server activates that exact hash only after policy and authorization rechecks. Required review
is the workspace default. `automatic` is an explicit owner setting and is never derived from a
workspace name. Public channels are visible to agents only after explicit seating; members-only
channels remain invitation-only. An agent inviter may delegate a valid, non-archived members-only channel only while it
has active membership there; a workspace-owner requester may grant any valid restricted channel in
the workspace. That authority is rechecked at redemption. `attachments-v1` only requests attachment
wire projections. File list/content routes still require `workspace:read` and repository-level
conversation visibility. File creation, byte writes, completion, and message attachment also
require the non-default `attachments:write` scope.

An eligible Hermes wake requests `agent-context-pack-v1` only after its self-message, author
allowlist, DM/channel-mention, and optional participated-thread gates pass. The server projects at
most 20 live messages from one already-authorized conversation in a repeatable-read snapshot,
resolves authors from the member records, and derives `mentionedYou` from verified mention rows.
It returns a canonical `#slug` or `@peer` selector, the anchor's one-level-thread reply target, and
an optional root outside the tail. The pack is capped at 64 KiB by dropping whole oldest messages;
ordinary history and clients that do not negotiate the capability keep their previous wire shape.
An anchored context `NOT_FOUND` covers both an unavailable trigger and a conversation that is no
longer visible. The adapter checkpoints that event without inference or read-state mutation, keeping
the privacy-preserving 404 and preventing one unavailable wake from poisoning every reconnect.

This deliberately widens model-visible content for an eligible wake: nearby messages from the
already-authorized conversation—including messages by authors who cannot independently wake
Hermes—can enter its transcript even when they did not mention the agent. The adapter labels the
entire projection as untrusted user content and places it in the inbound user message, never in
`channel_prompt` or another system-prompt seam. After successful model handoff it
atomically checkpoints the workspace delivery cursor and a pending read target, then advances the
server cursor only when the token also has `read-cursors:write`; failed advances retry without a
second inference. Tokens without that optional scope continue delivering context and warn once.

For a rolling desktop upgrade, public member-directory and `member.updated` projections encode an
agent as the previous release's `human` discriminator. Those shapes are mention/DM targets and do
not authorize a principal. Agent administration responses and the authenticated agent's own
principal retain the distinct `agent` kind and scoped contract.

Bot credentials are a separate task-only authentication path and are never accepted by desktop,
chat, search, bootstrap, sync, realtime, member-directory, DM, or session routes. Supplying an
`Authorization` header to a task route opts into bot authentication and cannot fall back to a
human cookie. Every bot request checks credential hash, expiry, revocation, active workspace
membership, required task scope, and an explicit channel grant. Authorization headers are redacted
from structured request logs. Bot tokens belong in the caller's secret store and never cross the
renderer boundary.

Magic-link and exchange responses do not reveal whether an email is invited. Limits are
five link requests per normalized email and 20 per source IP per hour, plus 20 exchanges per
IP per hour. Ordinary API limits are 120 requests and 30 message creates per member per
minute with bounded bursts. Cloudflare supplies coarse IP/WAF protection; Fastify enforces
identity and operation limits. SES uses verified DKIM, SPF, and DMARC domains. Passwords,
public signup, email changes, and account recovery outside owner re-invitation are absent.

### Encryption and data handling

TLS 1.2 or newer is required from client to Cloudflare, Cloudflare to ALB, ALB to service,
service to PostgreSQL (`verify-full`), and for every AWS API/object transfer. HSTS is enabled
for both web origins. Production RDS volumes/snapshots, S3 objects/versions, CloudWatch log
groups, CloudFormation artifacts, and secrets use KMS-backed encryption; S3 public access is
blocked at account and bucket level. Presigned upload/download URLs are capability URLs with
short expiry and exact object scope. Cloudflare, ALB, and application access logs omit or
redact query strings so magic-link, callback, realtime-ticket, and presigned URL secrets are
not captured.

The local encrypted-cache rules above are the desktop at-rest boundary; access credentials
remain main-only and refresh credentials are separately protected by `safeStorage`.
Application logs contain IDs, timings, status/error codes, and sizes—not message bodies,
search terms, filenames, email addresses, tokens, URL query strings, event payloads, or
presigned URLs. Email addresses may appear only in access-controlled audit records as a
keyed digest plus an operator-readable value encrypted under a dedicated key.

Messages and ready attachments are retained indefinitely for now because editing,
deletion, and user-configurable retention are deferred. Sync events expire after 90 days,
application logs after 30 days, abandoned uploads after 24 hours, and database point-in-time
recovery/backups after 35 days. Closing the workspace disables access immediately and
deletes active data and objects within 30 days; encrypted backups age out within the stated
35-day window. This limitation is disclosed to members.

### Deployment and operation

- GitHub Actions uses OIDC and short-lived AWS roles; production deploy/signing environments
  require owner approval. Secrets live in Secrets Manager or the platform signing service,
  never repository variables that can reach pull-request jobs.
- Database migrations run once as a pre-deploy task, take an advisory lock, and follow
  expand/backfill/contract. A release may roll back application tasks without rolling back a
  destructive migration; destructive cleanup waits until the previous client/server version
  is outside the compatibility window.
- Default agency follows a one-way expand/enable sequence. Apply the additive migrations and deploy
  compatible code with `HYPE_COMMS_DEFAULT_AGENT_AGENCY_ENABLED=false`. Stop every old server and
  realtime node and remove the old image as a rollback target, then enable the flag on every node.
  The service records the workspace cutover durably so a lagging compatible process cannot restore
  implicit public-channel access. After enablement, keep the flag on and forward-fix; do not restore
  an image that cannot parse the new scopes or membership model.
- Migration `0005_message_search.sql` populates a stored search vector and builds its GIN index in
  one transaction. Apply it during a maintenance window for an existing populated deployment;
  replace it with a staged online backfill/index build before message history reaches production
  scale.
- Channel slugs use Unicode NFKC normalization and locale-independent lowercase conversion. They
  retain Unicode letters, numbers, and following combining marks while other runs collapse to one
  ASCII hyphen; workspace slugs remain ASCII administrative identifiers.
- `/livez` checks only the process. `/readyz` checks database connectivity and migration
  compatibility and removes an unhealthy task from service. Deploys drain WebSockets and
  clients reconnect/sync; no sticky-session correctness is assumed.
- JSON logs carry request, session, user, workspace, conversation, and event IDs where relevant.
  The current service exposes bearer-protected Prometheus metrics for HTTP request count/duration,
  authenticated WebSocket connections, and PostgreSQL pool total/idle/waiting connections when
  `HYPE_COMMS_METRICS_TOKEN` is configured. Event lag, mutation/auth outcomes, search latency, email,
  attachment scanning, and desktop crash/update metrics remain target coverage.
- Page the operator for sustained availability/error-budget burn, database or event-log
  capacity, event lag above 30 seconds, backup failure, scan backlog above five minutes,
  or suspected credential abuse. User-level send and email failures create non-paging
  support signals with request IDs.
- RDS point-in-time recovery targets an RPO of five minutes and RTO of four hours. Automated
  restore checks run monthly; a documented restore plus attachment-access rehearsal is
  required before hosted production and quarterly thereafter. CloudTrail/audit records cover deploys,
  secret/key access, owner invitations/revocations, membership changes, and session
  revocations without recording chat content. Application audit also retains agent-enrollment
  transitions, requester credential ID, requested seats, review, policy timestamps, and activated
  identity/token IDs without credential material.
- Production has a runbook for auth/email failure, database saturation, event lag, malware
  backlog, compromised session/signing key, rollback, restore, and workspace shutdown.
  Dependency and base-image updates are reviewed weekly; critical security releases bypass
  the normal feature cadence.

The hosted-deployment service-level objectives are 99.5% monthly API availability, p95 under
500 ms from committed message creation to event delivery at current scale, and p95 under one second for
search against 100,000 messages, excluding client network time. These are measured at the
service and reported alongside error rates rather than inferred from anecdotes.

## Signing, distribution, and compatibility

Pull requests and pushes to `main` build DEV smoke packages on disposable GitHub-hosted ARM64
macOS, Windows, and Linux runners: macOS packages are ad-hoc signed, while Windows and Linux
packages remain unsigned. Manual smoke dispatches retain coverage on the isolated native
self-hosted runners. Only a version tag on `main` whose name matches the desktop package version
may invoke release jobs and credentials, which are protected by the `release` environment and
delivered only to disposable GitHub-hosted runners.
The current release path publishes immutable artifacts and manifests to the S3-compatible storage-backed generic
feed. Its platform-signature status is:

- macOS application bundles are Developer ID signed, notarized, stapled, and independently
  verified by the release workflow for arm64 and x64. The DMG container itself still needs
  fresh-download Gatekeeper evidence.
- Windows x64 and ARM64 NSIS artifacts stay unsigned until Azure Trusted Signing secrets and the
  exact publisher subject are present. The lane is inert without those values and fail-closed once
  they exist: `Get-AuthenticodeSignature` must report Valid on each installer and unpacked
  `hype-comms.exe` before upload. See [windows-signing.md](windows-signing.md). 0.1.29 clients have
  no `publisherName` and will still accept the first signed update.
- Linux x64 and ARM64 AppImage and Debian packages carry the updater manifest's SHA-512 digest but
  do not yet have a detached GPG signature or SBOM gate.

The hosted target adds Windows Authenticode/SmartScreen verification, Linux detached signatures,
SBOM and provenance generation, protected release-environment approval, authenticated rollout
metadata, and clean-host upgrade tests before publishing.

Release jobs generate provenance and an SBOM, then place immutable artifacts in a private,
versioned S3 release bucket. The authenticated latest-release endpoint returns version,
platform, architecture, publication time, minimum API/client versions, SHA-512 digest,
signature information, and a ten-minute signed download URL. Main downloads to a private
temporary path and verifies metadata, digest, platform signature, and monotonic version
before invoking an installer. Renderer content cannot select an update URL or bypass checks.

macOS and Windows prompt then install automatically through the Electron updater. Linux
checks and downloads through the same authenticated path but requires explicit installation
of the verified signed package. Rollout goes to the owner first, then all members after 24
healthy hours; the operator can pause a version at the metadata endpoint. The service
supports the current and immediately previous desktop version. An unsupported client gets a
clear mandatory-update response before normal sync. Server rollback uses the prior task
image; a bad desktop build is corrected by a higher signed patch version, never an unsigned
downgrade.

## Required test matrix

| Layer                      | Required cases and gate                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract/unit              | Strict schemas reject unknown/oversized data; domain tests cover capacity, direct/group participant cardinality and uniqueness, task ordering/version conflicts, thread depth, mention verification, reaction uniqueness, forward-only reads, file states, event audiences, cursor serialization, error redaction, and the exact `default-agency-v1` scope set. Runs on every pull request. |
| PostgreSQL/API integration | Run real migrations on supported PostgreSQL, then test invite/auth rotation and reuse, every route's positive and negative ACLs, fixed group membership, transactional event writes, permanent send and join idempotency, pagination boundaries, search isolation, attachment read/write boundaries, owner token revocation, and agent disablement. Runs on every pull request. |
| Sync/resilience            | Inject duplicate, missing, delayed, and out-of-order events; disconnect before/after commit; restart client/server; expire cursors/tokens; suspend/resume; corrupt cache ciphertext; revoke membership mid-session; and recover with outbox intact and one canonical message. Runs in CI with deterministic fault hooks.                                                               |
| Desktop security           | Assert BrowserWindow flags, CSP, navigation/window denial, IPC sender/schema/size checks, absence of tokens/Node globals in renderer, safeStorage failure fallback, encrypted IndexedDB sensitive fields, external URL validation, and cache wipe. Runs on every pull request.                                                                                                         |
| Feature integration        | Three-user scenarios cover channel/direct/group/task isolation, public discovery and join, private invitation, Kanban convergence and reassignment, threads, Unicode reactions/mentions without access changes, two-device unread convergence, 100k-message search, EICAR/rejected/abandoned uploads, URL expiry, notification focus/permission/click routing, and read-only `attachments-v1` retrieval without a desktop. Runs before a hosted release. |
| Native E2E                 | Baseline install/launch/logout/relaunch, deep links, OS keyring, tray/window lifecycle, offline restart, and uninstall run on every shipped platform's full [supported host matrix](#supported-host-matrix) row; a release never scopes this down. Optional-feature evidence—including notifications granted/denied—is scoped to the platforms in the change's declared scope, and an unproven platform ships that feature off rather than untested. Package smoke runs on relevant changes; the full release matrix runs for releases. |
| Update/release             | Upgrade from the immediately previous signed version, verify retained cache/outbox, reject altered manifest/artifact/wrong architecture/expired URL, pause rollout, and enforce minimum versions. Verify macOS notarization, Windows Authenticode, and Linux checksum/GPG signature on clean hosts. Blocks publishing.                                                                 |
| Load/operations            | With 25 connected members and 100,000 messages, sustain a 10 message/second burst while reconnecting clients and searching; meet latency/error SLOs. Exercise the one-way default-agency cutover, migration locking and compatibility, scan backlog alarm, PITR restore, object authorization, and RPO/RTO. Blocks opening a hosted deployment to members. |

No release may waive authorization, idempotency/data-loss, artifact-signature, or restore
tests. Flaky tests are treated as failed gates until fixed or replaced with an equivalent
deterministic check.
