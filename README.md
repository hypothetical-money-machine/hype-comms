# HMM Chat

HMM Chat is a private, desktop-first team chat. We build it as our own daily communication
tool, designed so it can grow into something other small teams can use. The current
implementation combines invited-member magic-link access with a PostgreSQL-backed
conversation core, reconnecting realtime delivery, and a restart-safe encrypted desktop outbox.

See [ROADMAP.md](ROADMAP.md) for status and direction,
[docs/architecture.md](docs/architecture.md) for the implementation contract, and
[docs/sqlite-cutover.md](docs/sqlite-cutover.md) for the SQLite-to-PostgreSQL
cutover boundary.

## Joining a workspace

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
docs               Architecture and operational notes
```

## Prerequisites for development

- Node.js 24.18.x
- npm 11.16.x
- PostgreSQL 16, normally through Docker Compose

Install exactly from the lockfile:

```bash
npm ci
```

## Local development

Everything below is for working on HMM Chat. Create `.env.local` with local-only values:

```dotenv
HMM_POSTGRES_PASSWORD=local-password
HMM_POSTGRES_BIND_PORT=5432
HMM_DEMO_POSTGRES_BIND_PORT=54330
HMM_DATABASE_URL=postgres://hmm:local-password@127.0.0.1:5432/hmm_chat
HMM_OWNER_EMAIL=you@example.com
HMM_EMAIL_DELIVERY=console
HMM_PUBLIC_API_URL=http://127.0.0.1:3000
HMM_ALLOWED_ORIGINS=http://127.0.0.1:5173
```

Start PostgreSQL, then the host server and Electron client:

```bash
docker compose --env-file .env.local up -d postgres
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

### Two-client demo

For UI and realtime work, start the complete local demo with:

```bash
npm run demo
```

The command uses the isolated `hmm-chat-demo` Compose project and PostgreSQL volume on loopback port
`54330` by default, so it can run beside the normal development database. It applies migrations,
idempotently seeds Claire, Woots, four channels, one direct conversation, and eight messages, then
starts the API and two isolated Electron profiles under `.dev-data/demo/desktop`. Authentication
callbacks are private one-shot files: Electron consumes each file only when its profile is signed
out, while a restored session wins after a main-process restart.

Use `npm run seed:demo` to start the same isolated PostgreSQL service, seed it, and write fresh
private callback files without launching the API or clients. Ordinary demo shutdown leaves its
PostgreSQL volume running for fast restarts. To erase only the demo database and Claire/Woots
profiles, first close the demo and run:

```bash
npm run demo:reset
```

The reset refuses to run while its launcher marker names a live process. It never removes the
normal Compose volume or standard Electron profiles.

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

## Desktop releases and updates

Packaged production clients read a public, flat update feed at
`https://updates.hypemm.com/desktop`. The feed contains `latest-mac.yml`, `latest.yml`,
`latest-linux.yml`, and the versioned installers those files name. Its URL is baked into the
package: there is intentionally no runtime setting that could redirect an installed client to a
different update server. Object storage is only the origin; clients need no bucket credential, and
the read path is deliberately unauthenticated because a packaged app cannot hold a secret.

To cut a release:

1. Change `apps/desktop/package.json` to the intended version and update the lockfile, without
   creating a tag yet.
2. Run `npm run check` and the native package verification appropriate to the machine.
3. Land that focused version change, then create and push `v<version>` at the exact revision. The
   release workflow rejects a tag whose value does not exactly match the desktop package version.

The workflow packages on native macOS, Windows, and Ubuntu runners with `--publish never`, verifies
the ASAR, update configuration, and Electron fuses, and then copies the results to the
S3-compatible bucket described below. The pilot serves this from a self-hosted S3-compatible storage instance on
the example-project cluster; any S3-compatible endpoint works, and the bucket is addressed by path.

The endpoint, bucket, and region are not secret and are repository **variables**:

- `GARAGE_S3_ENDPOINT`
- `GARAGE_S3_BUCKET`
- `GARAGE_S3_REGION`

Only the key pair is a repository **secret**, and it is scoped to read and write that one bucket:

- `GARAGE_ACCESS_KEY_ID`
- `GARAGE_SECRET_ACCESS_KEY`

Treat that key pair as equivalent to code execution on every pilot machine: whoever can write the
bucket controls what every installed client downloads and runs next.

Artifacts are uploaded under the bucket's `desktop/` prefix with long-lived immutable caching.
Each `latest*.yml` is uploaded only after its referenced artifacts and uses `Cache-Control:
no-cache`; this ordering keeps a polling client from seeing a pointer to a file that is not there
yet. The workflow never deletes old files. To withdraw a bad release, re-upload the previous
platform metadata files last. That stops clients that have not updated from taking the bad build;
because downgrades are deliberately disabled, clients already running it need a newer forward-fix
release.

macOS signing is configured. A Developer ID Application certificate signs the build from these
two repository secrets:

- `HMM_MACOS_CSC_LINK` (the base64-encoded Developer ID certificate)
- `HMM_MACOS_CSC_KEY_PASSWORD`

Notarization is enabled when the signed job also has all three of:

- `HMM_MACOS_APPLE_API_KEY_BASE64` (the base64-encoded App Store Connect API private key)
- `HMM_MACOS_APPLE_API_KEY_ID`
- `HMM_MACOS_APPLE_API_ISSUER`

Without the certificate secrets the macOS job fails at its verification step and publishes nothing,
which is deliberate: an unsigned macOS build cannot auto-update at all, because Squirrel.Mac will
not apply an update it cannot match to the running app's code signature. A red macOS job therefore
means "no macOS build shipped", while Windows and Linux still publish normally.

Windows installers are not signed. The update mechanism still works — `electron-updater` skips
Authenticode verification when no publisher name is recorded — but that means a Windows update is
protected by HTTPS and the manifest checksum rather than by a signature independent of the
transport. macOS is protected by Developer ID and notarization in addition to those. Closing that
gap needs a Windows code-signing certificate.

## Verification

Use the fast inner-loop check while iterating. It runs formatting, linting, typechecking, and
tests, but leaves production builds to the full gate:

```bash
npm run check:fast
```

Before opening a pull request, run the complete gate:

```bash
npm run check
```

Five server suites covering authorization, invitations, sessions, membership roles, workspace
access, and migrations silently skip when `HMM_TEST_DATABASE_URL` is absent. Run them against a
disposable PostgreSQL container matching the deployed major version with:

```bash
npm run test:db
```

The command lets Docker assign a free loopback port, waits for PostgreSQL readiness, and removes
the container after success, failure, or interruption.

The image defaults to the major version the pilot deploys, currently PostgreSQL 16, so the tests
exercise what production actually runs. Compose uses the same version for the same reason. Set
`HMM_TEST_POSTGRES_IMAGE` to check a different major version before proposing an upgrade, and
change both together with the deployment rather than letting them drift apart.

`test:db` is unaffected by this because its container is disposable, but a Compose volume already
initialised by a different major version will refuse to start, reporting incompatible database
files. Recreate it with `docker compose down -v` — that discards local development data only.

Desktop packaging is currently local and unsigned:

```bash
npm run package:desktop
npm run package:desktop:appimage
npm run verify:desktop-package
```

Generated `dist/`, `release/`, coverage, databases, credentials, and installers are never
committed.

## Continuous integration

Two systems run against this repository, split by what each can physically build.

**Woodpecker** (`.woodpecker.yml`) owns the server. On a push to `main` it runs `npm run check`,
builds the service image with kaniko, pushes it to the Harbor registry, and updates the
`deployment-repository` GitOps repository so Argo CD rolls it out to the `production-cluster` cluster. It runs
on the example-project, which is where the registry, the cluster, and the database already live.

**GitHub Actions** (`.github/workflows/`) owns repository checks and the desktop client:

- `ci.yml` runs `npm run check` on every pull request and push to `main`.
- `desktop-package-smoke.yml` packages unsigned artifacts on macOS, Windows, and Ubuntu.
- `desktop-release.yml` builds, signs, notarizes, verifies, and publishes a tagged release.

The desktop half cannot move to the example-project: macOS artifacts must be built and signed on macOS,
and Windows installers on Windows. GitHub provides those runners; the example-project does not.

Note that `npm run check` currently runs in both systems on a push to `main`. That duplication is
harmless but not free, and is worth collapsing if CI minutes or feedback latency start to matter.

## Scope

The current build serves one invited workspace of at most 25 active members. It covers
workspace-visible and members-only channels, 1:1 DMs, paginated text history, authorized
message search, mentions, unread state, ordered reconnect sync, date-separated timelines, and
restart-safe sends. Threads, reactions, attachments, notifications, signed
releases, and hosted operations are upcoming work — see [ROADMAP.md](ROADMAP.md).
