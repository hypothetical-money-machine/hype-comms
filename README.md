# Hype Comms

Hype Comms is a private, desktop-first team chat. We build it as our own daily communication
tool, designed so it can grow into something other small teams can use. The current
implementation combines optional WorkOS AuthKit and invited-member magic-link access,
first-class scoped agent identities, a PostgreSQL-backed conversation core, reconnecting realtime
delivery, and a restart-safe encrypted desktop outbox.

Product strategy and delivery work are tracked in
[Hype Comms on the tracker](https://github.com/hypothetical-money-machine/hype-comms/issues).
See [packages/cli/README.md](packages/cli/README.md) for CLI installation and automation
contracts, [integrations/hermes-hype-comms/README.md](integrations/hermes-hype-comms/README.md) for
the Hermes gateway adapter, and [docs/sqlite-cutover.md](docs/sqlite-cutover.md) for the
SQLite-to-PostgreSQL cutover boundary.

## Joining a workspace

If you only want to use Hype Comms, you do not need Docker, PostgreSQL, Node, or a local server.
Install the desktop build provided by the workspace owner and open it. When the deployment has
WorkOS AuthKit enabled, choose **Sign in with WorkOS** and finish in the system browser. You can
also enter your invited email address and follow a magic link when that rollout-compatible method
is enabled. Either method creates or restores the same local identity and revocable device session.

The shared access code has been retired. Ask the workspace owner for an invitation if your email
address has not been admitted yet.

A valid WorkOS identity is not registration: its exact verified email must already belong to an
active Hype Comms member or an unexpired local invitation. See
[the AuthKit setup and security guide](docs/workos-authkit.md) for deployment configuration.

## Repository layout

```text
apps/desktop       Electron main, preload, and React renderer
apps/server        Fastify HTTP/WebSocket service and PostgreSQL migrations
packages/cli       Node command-line client and machine-readable automation surface
packages/contracts Strict Zod schemas shared across every wire boundary
integrations       Separately distributed first-party platform adapters
docs               Operational runbooks and showcase assets
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

Everything below is for working on Hype Comms. Create `.env.local` with local-only values:

```dotenv
HYPE_COMMS_POSTGRES_PASSWORD=local-password
HYPE_COMMS_POSTGRES_BIND_PORT=5432
HYPE_COMMS_DEMO_POSTGRES_BIND_PORT=54330
HYPE_COMMS_DATABASE_URL=postgres://hype_comms:local-password@127.0.0.1:5432/hype_comms
HYPE_COMMS_OWNER_EMAIL=you@example.com
HYPE_COMMS_EMAIL_DELIVERY=console
HYPE_COMMS_PUBLIC_API_URL=http://127.0.0.1:3000
HYPE_COMMS_ALLOWED_ORIGINS=http://127.0.0.1:5173
```

Start PostgreSQL, then the host server and Electron client:

```bash
docker compose --env-file .env.local up -d postgres
npm run dev
```

In console delivery mode, request a magic link in the app and copy the loopback link from the
server log. An owner can also issue a manual invitation:

```bash
npm run invite --workspace @hype-comms/server -- --email member@example.com
```

The landing page offers both `Hype Comms` and `Hype Comms DEV`. The recipient chooses the
application because a magic-link request is unauthenticated and cannot safely choose where the
credential is sent.

To exercise AuthKit locally, register
`http://127.0.0.1:3000/v1/auth/workos/callback` for a WorkOS test Application and add the optional
values documented in [docs/workos-authkit.md](docs/workos-authkit.md) to `.env.local`. The WorkOS
API key and both PKCE verifiers remain outside the renderer. Explicitly set
`HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED=true` only for the local AuthKit exercise; admission defaults off.

Owners can provision task-only bot members with scoped, expiring credentials and explicit channel
grants. Tokens are printed once and never enter the desktop renderer:

```bash
npm run bot --workspace @hype-comms/server -- create \
  --username release-bot \
  --display-name "Release Bot" \
  --channel general
```

See [docs/bot-tasks.md](docs/bot-tasks.md) for scopes, rotation/revocation, and API examples.

An additional desktop identity needs isolated Electron storage:

```bash
npm run dev:join -- --profile=dan
```

### Two-client demo

For UI and realtime work, start the complete local demo with:

```bash
npm run demo
```

The command uses the isolated `hype-comms-demo` Compose project and PostgreSQL volume on loopback port
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

### Headless agent captures

For local agent-driven UI checks, the real Electron renderer can run without showing native
windows. It still needs a local desktop session; this is not a display-server-free browser mode.

For the complete, opt-in local round trip—start the demo, send Claire → Woots, capture a Woots
PNG and Claire WebM, then stop the demo—run:

```bash
npm run test:demo:headless
```

To keep the demo open for iterative agent work, use the launcher and attach-only smoke command in
separate terminals instead:

```bash
# Terminal 1: starts the isolated Claire/Woots demo and leaves it running.
npm run demo:headless -- --cdp-base-port=9222

# Terminal 2: sends one Claire → Woots direct message, verifies the realtime receipt,
# and writes a Woots PNG plus a Claire WebM recording.
npm run demo:headless:smoke
```

The launcher prints one versioned readiness JSON record only after both clients have rendered
`[data-testid="workspace-ready"]`. Its private, secret-free session manifest is
`.dev-data/demo/headless-session.json`; it contains loopback CDP URLs and a new private,
run-specific artifact directory. The smoke command reads that manifest by default (or use
`HYPE_COMMS_HEADLESS_DEMO_MANIFEST=/absolute/path/session.json`) and preserves its artifacts rather than
deleting prior runs.

Automation can reuse [`scripts/agent-capture.mjs`](scripts/agent-capture.mjs) from another local
ESM script. It dynamically imports Playwright, so normal development does not load it:

```js
import {
  capturePng,
  connectToCdp,
  startWebmScreencast,
  stopWebmScreencast,
  waitForWorkspaceReady,
} from "./scripts/agent-capture.mjs";

const client = await connectToCdp("http://127.0.0.1:9222");
try {
  await waitForWorkspaceReady(client.page);
  const recording = await startWebmScreencast(client.page, "/tmp/agent-flow.webm");
  // Drive the normal renderer with Playwright locators here.
  await capturePng(client.page, "/tmp/agent-flow.png");
  await stopWebmScreencast(recording);
} finally {
  await client.disconnect();
}
```

CDP is development-only and loopback-only. Treat the endpoint and manifest like local automation
capabilities: do not expose either outside the machine. The capture helper uses fixed CSS-scale
PNG settings and Playwright 1.59's explicit `page.screencast` WebM API; headless renderers are
excluded from read tracking even while an agent drives their controls.

The API applies forward-only migrations on startup. Migration filenames and checksums are
recorded under an advisory lock; add a new numbered file and never edit an applied migration.

### Pointing a development client at a deployment

`HYPE_COMMS_API_ORIGIN` is read at build time. Development accepts loopback HTTP or a
credential-free HTTPS origin:

```bash
HYPE_COMMS_API_ORIGIN=https://chat-api.example.invalid npm run dev:desktop
```

Plain HTTP to a non-loopback host is rejected.

## CLI and agent integrations

Build and run the workspace CLI with Node 24:

```bash
npm run build --workspace @hype-comms/cli
npm exec --workspace @hype-comms/cli -- hype-comms-cli --help
```

The CLI supports named private profiles plus `HYPE_COMMS_API_ORIGIN`, `HYPE_COMMS_TOKEN`,
`HYPE_COMMS_PROFILE`, and `HYPE_COMMS_CONFIG_DIR` overrides. HTTPS is required except for loopback
development servers. Human sessions can request and exchange magic links; agent credentials are
read from a private prompt, stdin, an injected environment variable, or a `0600` profile file.
Do not put credentials in command arguments.

Workspace owners create agent members and their immutable scoped tokens through a human CLI
profile. A token is shown once, at creation, and cannot be recovered later; revoke it and create a
replacement if it is lost. Agents count toward the same 25-active-member limit as people. See the
[CLI guide](packages/cli/README.md) for commands, JSON/NDJSON output, retry behavior, and stable
exit codes.

The [Hermes adapter](integrations/hermes-hype-comms/README.md) runs the CLI as its transport. It
wakes Hermes for every DM and only for channel messages that explicitly mention the agent, resumes
one Hermes session per Hype Comms conversation, and sends replies back to that canonical
conversation.
Install the server migration first, then the CLI, provision the agent and token, install the
adapter under `~/.hermes/plugins/`, and finally start the Hermes gateway.

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

`HYPE_COMMS_EMAIL_DELIVERY=manual` permits an administrator to issue links without an SMTP provider.
Self-service requests return a uniform refusal in that mode. Configure `HYPE_COMMS_SMTP_URL` and
`HYPE_COMMS_EMAIL_FROM`, then select `smtp`, for delivered mail.

AuthKit is optional and additive. Stage its provider, webhook, and trusted-proxy values from
[docs/workos-authkit.md](docs/workos-authkit.md), then use the explicit admission gate after every
serving instance is compatible; leaving the provider unset preserves the current magic-link
deployment. Partial configuration fails startup instead of exposing a broken sign-in button.

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
`latest-linux.yml`, `latest-linux-arm64.yml`, and the versioned installers those files name. Its
URL is baked into the package: there is intentionally no runtime setting that could redirect an
installed client to a different update server. Object storage is only the origin; clients need no
bucket credential, and the read path is deliberately unauthenticated because a packaged app
cannot hold a secret.

To cut a release:

1. Fetch and update from `origin/main`, make sure the checkout has no unrelated changes, then run
   `npm run release -- <version>` (for example, `npm run release -- 0.1.25`). The command first
   rejects unrelated worktree changes, then updates the desktop manifest and matching lockfile entry
   and creates `docs/releases/v<version>.md`. It never commits, tags, pushes, or publishes. Omitting
   the version is an error that prints the locally suggested next patch without changing files.
2. Review the generated notes scaffold, replace its instructional text, and remove its review
   marker, following the [release-notes guide](docs/releases/README.md). Re-running the command for
   the same version preserves the edited notes.
3. Run `npm run check`. On a packaging machine, explicitly select the release identity for both
   commands: `HYPE_COMMS_BUILD_FLAVOR=production npm run package:desktop`, then
   `HYPE_COMMS_BUILD_FLAVOR=production npm run verify:desktop-package`.
4. Land that focused version change, then create and push `v<version>` at the exact revision. The
   release workflow rejects a tag whose value does not exactly match the desktop package version or
   whose release notes still contain the review marker.

The workflow packages x64 and ARM64 clients on macOS, Windows ARM64, and Ubuntu ARM64 runners with
`--publish never`, verifies the ASAR, update configuration, and Electron fuses, and then copies the
results to the S3-compatible bucket described below. It also creates or updates a Hype Comms GitHub
Release for the tag, prepending the reviewed notes to GitHub's generated pull-request history and
attaching the versioned installers, blockmaps, and generated updater manifests. Publication fails
if the release body does not contain the reviewed notes. Those GitHub Release assets are a
manual-download archive; installed clients continue to use the public feed.
Only the ARM64 clients are built natively:
there is no longer an x64 runner in the release path, so the x64 Windows and Linux artifacts are
cross-built and fuse-verified on those same ARM64 hosts and no x64 machine exercises them before
publishing. The pilot serves this from a self-hosted S3-compatible storage instance on the example-project cluster; any
S3-compatible endpoint works, and the bucket is addressed by path.

Ordinary development and ad hoc package builds compile native notification presentation off. The
signed/notarized macOS release build includes it for an opt-in pilot, while Windows and Linux
release builds explicitly compile it off. Implementation Milestones 0 through 3—DMs, verified
mentions, capability-gated participated-thread replies, preferences, exact click-through, and
replica-first macOS window recreation—are complete behind the default-off device setting. A signed
macOS ARM64 run now proves installed synthetic toast delivery and click restoration, but the
remaining macOS, Windows, and Ubuntu Milestone 4 matrix in the
[native-notifications roadmap](docs/native-notifications-roadmap.md) remains open; package smoke
alone is not display or click evidence.

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

- `HYPE_COMMS_MACOS_CSC_LINK` (the base64-encoded Developer ID certificate)
- `HYPE_COMMS_MACOS_CSC_KEY_PASSWORD`

Notarization is enabled when the signed job also has all three of:

- `HYPE_COMMS_MACOS_APPLE_API_KEY_BASE64` (the base64-encoded App Store Connect API private key)
- `HYPE_COMMS_MACOS_APPLE_API_KEY_ID`
- `HYPE_COMMS_MACOS_APPLE_API_ISSUER`

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
tests, but leaves workspace builds to the full gate:

```bash
npm run check:fast
```

Before opening a pull request, run the complete gate:

```bash
npm run check
```

Five server suites covering authorization, invitations, sessions, membership roles, workspace
access, and migrations silently skip when `HYPE_COMMS_TEST_DATABASE_URL` is absent. Run them against a
disposable PostgreSQL container matching the deployed major version with:

```bash
npm run test:db
```

The command lets Docker assign a free loopback port, waits for PostgreSQL readiness, and removes
the container after success, failure, or interruption.

The image defaults to the major version the pilot deploys, currently PostgreSQL 16, so the tests
exercise what production actually runs. Compose uses the same version for the same reason. Set
`HYPE_COMMS_TEST_POSTGRES_IMAGE` to check a different major version before proposing an upgrade, and
change both together with the deployment rather than letting them drift apart.

`test:db` is unaffected by this because its container is disposable, but a Compose volume already
initialised by a different major version will refuse to start, reporting incompatible database
files. Recreate it with `docker compose down -v` — that discards local development data only.

Local desktop packaging defaults to the side-by-side `Hype Comms DEV` identity. macOS DEV packages
are ad-hoc signed so the modified Electron application can launch, but are not notarized. The DEV
application has its own native application ID, executable, Linux package, profile, sign-in protocol,
and output directory. It cannot read the stable profile or install updates from the stable feed.

```bash
npm run package:desktop
npm run package:desktop:appimage
npm run verify:desktop-package
```

Tagged release jobs set `HYPE_COMMS_BUILD_FLAVOR=production` at the job level. That explicit flavor
retains the existing `Hype Comms` identity, `hype-comms-*` artifact names, release directory, and
update feed. Do not set the production flavor for an ordinary preview build.

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
- `desktop-package-smoke.yml` packages the default DEV artifacts on macOS, Windows, and Ubuntu,
  then packages production on Linux to check the stable identity and updater feed before a tag.
  macOS DEV artifacts are ad-hoc signed; the Windows and Ubuntu artifacts remain unsigned. Its
  signed macOS notification-evidence job selects the production identity because that evidence
  applies to a release candidate.
- `desktop-release.yml` builds, signs, notarizes, verifies, and publishes a tagged release.

The desktop half cannot move to the example-project: macOS artifacts must be built and signed on macOS,
and Windows installers on Windows. GitHub provides those runners; the example-project does not.

Note that `npm run check` currently runs in both systems on a push to `main`. That duplication is
harmless but not free, and is worth collapsing if CI minutes or feedback latency start to matter.

## Scope

The current build serves one invited workspace of at most 25 active members. It covers
workspace-visible and members-only channels, 1:1 DMs, paginated text history, authorized
message search, mentions, reactions, unread state, ordered reconnect sync, date-separated
timelines, one-level threads, scoped agent identities, and restart-safe sends. The repository also
contains native-notification Milestones 0 through 3 behind default-off build and device settings;
installed notification proof and any default flip remain open alongside attachments, complete
release signing, and hosted operations. Product direction and delivery status are tracked in
[Hype Comms on the tracker](https://github.com/hypothetical-money-machine/hype-comms/issues).
