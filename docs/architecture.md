# Architecture

Hype Comms is an Electron desktop client backed by a Fastify service and PostgreSQL. This document
describes the code and release behavior in this repository. Product work that is not implemented
belongs in GitHub Issues and [ROADMAP.md](../ROADMAP.md).

## Product limits

The service hosts one invite-only workspace with at most 25 active members. A member is a human,
agent, or task bot. Humans sign in with an email magic link or, when enabled, WorkOS AuthKit.
Owners invite human members and provision agents and bots. There is no public registration,
multi-workspace support, browser client, mobile client, group DM, or message editing.

Channels are workspace-visible or members-only. Workspace-visible channels are available to active
human and agent members. Members-only channels require conversation membership and retain at least
one channel owner. Bots need an explicit grant for every channel and cannot access DMs. Direct
conversations have two participant slots; a self-DM uses both slots for the same member.

The desktop supports channels, 1:1 DMs, one-level threads, reactions, verified mentions, unread
state, message search, attachments, task boards, scoped agents, task bots, and a restart-safe
outbox. Native notifications are present behind a build flag and a disabled-by-default device
preference. See [native-notifications-roadmap.md](native-notifications-roadmap.md) for the
remaining platform evidence.

### Supported host matrix

| Platform | OS versions | Architectures | Package formats |
| --- | --- | --- | --- |
| macOS | Current and immediately previous major release | arm64, x64 | DMG |
| Windows | Windows 11 | x64, ARM64 | NSIS |
| Linux | Ubuntu 24.04 LTS | x64, ARM64 | AppImage, Debian |

A platform-scoped feature needs evidence for the cells named by its change. Shared security,
data, wire-contract, migration, and release checks apply to every platform.

## Components and boundaries

```text
React renderer -> validated preload IPC -> Electron main -> authenticated HTTPS and WSS -> Fastify -> PostgreSQL
```

`packages/contracts` contains the strict Zod schemas used at HTTP, IPC, and realtime boundaries.
The renderer has no Node APIs, product credentials, or direct product-network access. Electron main
owns window lifecycle, local preferences, credential storage, cache cryptography, updates, and
authenticated transport. Preload exposes a typed, validated IPC API. Fastify authenticates and
authorizes every request, applies business rules, and publishes realtime events. PostgreSQL stores
the canonical domain data and the ordered sync log.

The service processes plaintext for authorization, search, and attachment handling. Hype Comms is
not end-to-end encrypted. The encrypted desktop cache is a local-at-rest boundary, not a server
privacy boundary.

## Data and sync

PostgreSQL is authoritative. The renderer cache is disposable and must be rebuilt through HTTP
without losing the local outbox. A mutation, its idempotency result, and its audience-scoped sync
event commit in one transaction. Realtime notifications wake clients; `/v1/sync` repairs gaps.

Each queued desktop message uses one UUID for `clientMessageId` and `Idempotency-Key`. Retrying an
uncertain send returns the original message when the actor, route, key, and body match. A reused key
with a different request returns `409 CONFLICT`.

The renderer stores recent workspace data and the outbox in IndexedDB. Sensitive records are
AES-256-GCM encrypted through a bounded Electron-main API. The encryption key is protected with
Electron `safeStorage`; Linux uses a labeled memory-only cache when Electron reports the insecure
`basic_text` backend.

Workspace events have a global sequence and a defined audience. Message ordering uses a separate
per-conversation sequence. The server retains sync events for 90 days. A client whose cursor has
expired rebuilds its snapshot and resumes from a current cursor.

| Data | Current rule |
| --- | --- |
| Members | Usernames are unique lowercase handles. Human emails are normalized and unique. Active capacity includes people, agents, and bots. |
| Sessions | Magic links and AuthKit create rotating, revocable device sessions. The server stores credential hashes, not plaintext credentials. |
| Messages | Bodies are immutable after creation, except for the author-only five-minute retraction window. Replies point to a top-level message in the same conversation. |
| Mentions | The client sends member IDs with `@username` text. The server verifies the active member and stable handle before it stores a mention. |
| Reactions | One member/message/emoji row is allowed. Add and remove are idempotent. |
| Tasks | Channel and self-DM task projects use `todo`, `in_progress`, and `done`, optimistic versions, and ranks within a column. |
| Attachments | A message accepts up to ten ready attachments, each no larger than 25 MiB. Executables are rejected. |

The service checks conversation visibility for history, tasks, sync, search, files, and events.
Knowing an ID never grants access.

## Interfaces

Product routes live under `/v1` and use JSON except for direct object transfers. Shared schemas
reject unknown fields and invalid values. API errors use:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "...",
    "requestId": "..."
  }
}
```

Collection responses use opaque `before` and `after` cursors. The default page size is 50 and the
maximum is 100. Realtime access starts with an authenticated ticket; ticket redemption creates a
scoped WebSocket connection. Clients validate every event and repair a missed or invalid sequence
through HTTP sync.

## Authentication and access

Electron main performs human sign-in and holds access credentials. Access credentials last 15
minutes. Refresh credentials rotate on use, and reuse revokes the device-session family. Removing
a member or revoking a session takes effect on the next authorized request and realtime ticket.

WorkOS AuthKit is optional. It verifies an upstream identity, then applies Hype Comms invitation
and capacity rules before creating the usual local device session. The provider's access and refresh
tokens are discarded. [workos-authkit.md](workos-authkit.md) contains configuration, deployment,
and rollback instructions.

Agents use immutable bearer-token scopes for workspace reads, message writes, conversation writes,
and read-cursor writes. Bots use a separate task-only authentication path with `tasks:read` and
`tasks:write` scopes plus explicit channel grants. Neither token type reaches the renderer. See
[bot-tasks.md](bot-tasks.md) and [the CLI guide](../packages/cli/README.md).

## Desktop security

Every `BrowserWindow` enables context isolation, sandboxing, web security, and a fixed local
preload while disabling Node integration. Navigation and new windows are denied. Main validates and
opens allowlisted HTTPS links and RFC 6068 `mailto:` links in the operating system. Other schemes
are rejected.

The production Content Security Policy permits only local renderer content. The app does not expose
Electron `remote`, arbitrary IPC, shell execution, generic filesystem access, or generic networking
to the renderer. IPC handlers validate the sender, origin, payload schema, and size.

## Delivery and updates

An ordinary desktop package uses the side-by-side `Hype Comms DEV` identity. Production packages
use the stable `Hype Comms` identity, `hype-comms://` sign-in links, and the update feed at
`https://updates.hypemm.com/desktop`. The public feed contains updater metadata and versioned
artifacts; installed clients do not need storage credentials.

macOS production builds are signed and notarized. Windows signing is prepared but no Azure Trusted
Signing identity is configured, so Windows installers are currently unsigned. Linux packages have
updater checksums but no detached-signature, SBOM, or provenance release gate. See
[windows-signing.md](windows-signing.md).

GitHub Actions runs source checks and desktop packaging. A tagged desktop release packages and
publishes production artifacts after its reviewed release notes pass validation. Woodpecker builds
the server image and promotes it through the separate deployment repository. Kubernetes manifests,
ingress, database backup policy, secret injection, and production rollback evidence live there;
this repository does not claim that evidence.

## Operations and verification

`GET /livez` confirms that the process can answer HTTP. `GET /readyz` returns `503` while the
service is draining or PostgreSQL is unavailable. Setting `HYPE_COMMS_METRICS_TOKEN` enables the
bearer-protected `/metrics` endpoint for HTTP request, realtime connection, PostgreSQL pool, and
refresh-token-reuse metrics.

Run `npm run check` before a pull request. Run `npm run test:db` when the change affects database
behavior. Native package or installed-behavior evidence is required for the platforms affected by a
desktop change. [operations.md](operations.md) describes the release and rollback checks.
