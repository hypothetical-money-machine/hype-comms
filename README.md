# HMM Chat

HMM Chat is a private, desktop-first team chat for one Hypothetical Money Machine workspace.
The current implementation combines invited-member magic-link access with a PostgreSQL-backed
conversation core, reconnecting realtime delivery, and a restart-safe encrypted desktop outbox.

See [ROADMAP.md](ROADMAP.md) for milestone status,
[docs/architecture.md](docs/architecture.md) for the implementation contract, and
[docs/milestones/m2-cutover.md](docs/milestones/m2-cutover.md) for the SQLite-to-PostgreSQL
cutover boundary.

## Joining the pilot

If you only want to use HMM Chat, you do not need Docker, PostgreSQL, Node, or a local server.
Install the desktop build provided by the workspace owner, open it, enter your invited email
address, and follow the sign-in link. The link creates or restores your per-person identity and
revocable device session.

The shared access code has been retired. Ask the workspace owner for an invitation if your email
address has not been admitted yet.

## Repository layout

```text
apps/desktop       Electron main, preload, and React renderer
apps/server        Fastify HTTP/WebSocket service and PostgreSQL migrations
packages/contracts Strict Zod schemas shared across every wire boundary
docs               Architecture, milestone sign-offs, and cutover notes
```

## Prerequisites for development

- Node.js 24.18.x
- npm 11.16.x
- PostgreSQL 18, normally through Docker Compose

Install exactly from the lockfile:

```bash
npm ci
```

## Local development

Everything below is for working on HMM Chat. Create `.env.local` with local-only values:

```dotenv
HMM_DATABASE_URL=postgres://hmm:local-password@127.0.0.1:5432/hmm_chat
HMM_OWNER_EMAIL=you@example.com
HMM_EMAIL_DELIVERY=console
HMM_PUBLIC_API_URL=http://127.0.0.1:3000
HMM_ALLOWED_ORIGINS=http://127.0.0.1:5173
```

Start PostgreSQL, then the host server and Electron client:

```bash
# Use a matching HMM_POSTGRES_PASSWORD in .env for Compose.
docker compose up -d postgres
npm run dev
```

In console delivery mode, request a magic link in the app and copy the loopback link from the
server log. An owner can also issue a manual invitation:

```bash
npm run invite --workspace @hmm-chat/server -- --email member@example.com
```

An additional desktop identity needs isolated Electron storage:

```bash
npm run dev:join -- --profile=dan
```

The API applies forward-only migrations on startup. Migration filenames and checksums are
recorded under an advisory lock; add a new numbered file and never edit an applied migration.

### Pointing a development client at a deployment

`HMM_CHAT_API_ORIGIN` is read at build time. Development accepts loopback HTTP or a
credential-free HTTPS origin:

```bash
HMM_CHAT_API_ORIGIN=https://chat-api.example.invalid npm run dev:desktop
```

Plain HTTP to a non-loopback host is rejected.

## Container deployment

Copy the example, generate the PostgreSQL password, set the owner address and database URL, then
start both services:

```bash
cp .env.example .env
docker compose up --build -d
```

The API and database ports bind to loopback. PostgreSQL is authoritative for identity, sessions,
conversations, messages, idempotency records, read cursors, and sync events. There is no SQLite
runtime volume or shared access-code mode.

`HMM_EMAIL_DELIVERY=manual` permits an administrator to issue links without an SMTP provider.
Self-service requests return a uniform refusal in that mode. Configure `HMM_SMTP_URL` and
`HMM_EMAIL_FROM`, then select `smtp`, for delivered mail.

## Reliable delivery model

Message creation and its audience-scoped sync event commit in one PostgreSQL transaction.
Clients repair realtime gaps through `/v1/sync`; WebSocket notifications only wake delivery.
Every queued desktop send stores one UUID as both client message ID and idempotency key before
networking starts. Retry after a process or network failure therefore resolves to one canonical
server message.

Recent workspace data and the outbox live in renderer-owned IndexedDB. Sensitive record payloads
are AES-256-GCM encrypted through a bounded Electron-main API using a data key protected by
`safeStorage`. Linux falls back to a clearly labeled memory-only mode when Electron reports the
insecure `basic_text` backend.

## Verification

```bash
npm run check
```

To include real PostgreSQL repository and migration tests:

```bash
HMM_TEST_DATABASE_URL=postgres://hmm:password@127.0.0.1:5432/hmm_chat_test \
  npm test --workspace @hmm-chat/server
```

Desktop packaging remains local until M4:

```bash
npm run package:desktop
npm run package:desktop:appimage
npm run verify:desktop-package
```

Generated `dist/`, `release/`, coverage, databases, credentials, and installers are never
committed.

## Scope

The pilot is limited to one invited workspace and 25 active members. M2 covers channels, 1:1
DMs, paginated text history, mentions, unread state, ordered reconnect sync, and restart-safe
sends. Threads, reactions, attachments, search, notifications, signed releases, and hosted
production operations remain later milestones.
