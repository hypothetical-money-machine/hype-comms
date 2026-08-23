# Hype Comms

Hype Comms is a private, desktop-first chat app for one invited workspace. It has channels, 1:1
DMs, one-level threads, reactions, verified mentions, unread state, search, file attachments, task
boards, scoped agents, task bots, reconnecting sync, and an encrypted local cache with a
restart-safe outbox. The service uses PostgreSQL. The desktop is Electron.

Product work is tracked in
[GitHub Issues](https://github.com/hypothetical-money-machine/hype-comms/issues). The current
architecture is in [docs/architecture.md](docs/architecture.md), operational guidance is in
[docs/operations.md](docs/operations.md), and the product backlog is in [ROADMAP.md](ROADMAP.md).

## Join a workspace

Install the desktop build supplied by the workspace owner. You do not need Docker, PostgreSQL,
Node, or a local server.

Choose **Sign in with WorkOS** when the deployment has AuthKit enabled, or use an invitation magic
link. Both paths create the same local identity and revocable device session. A verified WorkOS
identity must match an active member or an unexpired invitation. The shared access code is retired.

See [docs/workos-authkit.md](docs/workos-authkit.md) for AuthKit configuration and deployment
requirements.

## Repository layout

```text
apps/desktop       Electron main, preload, and React renderer
apps/server        Fastify service and PostgreSQL migrations
packages/cli       Node command-line client
packages/contracts Shared strict Zod schemas
integrations       First-party platform adapters
docs               Product, operational, and release documentation
```

## Develop locally

Use Node.js 24.18.x, npm 11.16.x, and PostgreSQL 16. Install from the lockfile:

```bash
npm ci
```

Create `.env.local` with local-only values:

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

Start PostgreSQL, then the API and desktop app:

```bash
docker compose --env-file .env.local up -d postgres
npm run dev
```

Console email delivery prints a loopback magic link in the server log. An owner can also issue an
invitation:

```bash
npm run invite --workspace @hype-comms/server -- --email member@example.com
```

Use the owner command to manage workspace owners. Promote the replacement before demoting the
former owner. The last active owner cannot be demoted.

```bash
npm run owner --workspace @hype-comms/server -- promote member@example.com
npm run owner --workspace @hype-comms/server -- demote former-owner
npm run owner --workspace @hype-comms/server -- list
```

The sign-in landing page lets the recipient choose `Hype Comms` or `Hype Comms DEV`. The
request cannot choose the desktop application because it is unauthenticated.

To test AuthKit locally, register
`http://127.0.0.1:3000/v1/auth/workos/callback` with a WorkOS test Application, add the values
from [docs/workos-authkit.md](docs/workos-authkit.md) to `.env.local`, and set
`HYPE_COMMS_AUTHKIT_ADMISSION_ENABLED=true`. The renderer never receives the WorkOS API key or
PKCE verifiers.

Owners can create task-only bot members with explicit channel grants:

```bash
npm run bot --workspace @hype-comms/server -- create \
  --username release-bot \
  --display-name "Release Bot" \
  --channel general
```

The command prints the token once. Store it outside the desktop app. See
[docs/bot-tasks.md](docs/bot-tasks.md) for scopes, rotation, revocation, and API examples.

Start another desktop identity with its own Electron storage:

```bash
npm run dev:join -- --profile=dan
```

### Run the two-client demo

```bash
npm run demo
```

The demo uses a separate Compose project, database volume, Electron profiles, and loopback port
`54330` by default. It seeds Claire, Woots, channels, a DM, and messages. Run
`npm run seed:demo` to seed without starting the API or clients. Run `npm run demo:reset` after
closing the demo to remove only its database and profiles.

For headless desktop checks:

```bash
npm run test:demo:headless
```

For an iterative session, run the launcher and smoke test in separate terminals:

```bash
npm run demo:headless -- --cdp-base-port=9222
npm run demo:headless:smoke
```

The launcher writes a private session manifest under `.dev-data/demo/` after both clients render
the workspace. The smoke test captures a PNG and WebM in a private run directory. CDP is
development-only and loopback-only.

### Connect a development client to a deployment

`HYPE_COMMS_API_ORIGIN` is a build-time setting. Development accepts loopback HTTP or
credential-free HTTPS:

```bash
HYPE_COMMS_API_ORIGIN=https://chat-api.example.invalid npm run dev:desktop
```

Non-loopback HTTP is rejected.

## CLI and Hermes

Build and run the CLI with Node 24:

```bash
npm run build --workspace @hype-comms/cli
npm exec --workspace @hype-comms/cli -- hype-comms-cli --help
```

The CLI uses private named profiles and supports `HYPE_COMMS_API_ORIGIN`,
`HYPE_COMMS_TOKEN`, `HYPE_COMMS_PROFILE`, and `HYPE_COMMS_CONFIG_DIR` overrides. It requires
HTTPS except for loopback development. Do not pass credentials as command arguments. See
[packages/cli/README.md](packages/cli/README.md) for commands, JSON and NDJSON output, and exit
codes.

Workspace owners create agent members and immutable scoped tokens through a human CLI profile. A
token is shown once and cannot be recovered. Agents count toward the 25-member limit.

The [Hermes adapter](integrations/hermes-hype-comms/README.md) uses the CLI as its transport. It
wakes Hermes for DMs and channel messages that mention the agent. Thread follow-ups are optional;
see the adapter README before enabling them.

## Deploy the container

```bash
cp .env.example .env
docker compose up --build -d
```

The API and database bind to loopback. PostgreSQL stores identities, sessions, conversations,
messages, idempotency records, read cursors, and sync events. SQLite and the shared access-code
path are retired.

Set `HYPE_COMMS_TRUSTED_PROXIES` to the narrowest stable proxy address or CIDR. The proxy must
replace `X-Forwarded-For`, not append a client-controlled value. Leave proxy trust disabled for
direct development.

Set `HYPE_COMMS_EMAIL_DELIVERY=manual` for owner-issued links without SMTP. To send email, set
`HYPE_COMMS_SMTP_URL` and `HYPE_COMMS_EMAIL_FROM`, then select `smtp`.

AuthKit remains optional. Configure its provider, webhook, and proxy values together, deploy the
compatible server everywhere, and then enable the admission gate. Leaving provider settings unset
keeps magic-link sign-in available.

## Data, security, and notifications

Message creation and its sync event commit together in PostgreSQL. Realtime wakes clients and
`/v1/sync` repairs gaps. Each queued desktop message writes one UUID before networking starts, so
retrying an uncertain send resolves to one server message.

The renderer cache and outbox live in IndexedDB. Sensitive payloads are encrypted through Electron
main with AES-256-GCM and a `safeStorage`-protected key. Linux uses a labeled memory-only fallback
when its key store is insecure.

Native notifications are off in development and ordinary package builds. The signed macOS release
artifact contains an opt-in controller; Windows and Linux release artifacts do not. Every device
starts with notifications and message previews disabled. See
[docs/native-notifications-roadmap.md](docs/native-notifications-roadmap.md) for the status and
platform evidence.

## Releases and updates

Production desktop clients read the public update feed at
`https://updates.hypemm.com/desktop`. The feed names immutable artifacts and platform updater
metadata. The update URL is part of the production package and cannot be changed at runtime.

Prepare a release with:

```bash
npm run release -- <version>
```

The command updates the desktop version and lockfile entry and creates the versioned release-notes
file. It does not commit, tag, push, or publish. Run `npm run check`, package with the production
flavor on the relevant hosts, merge the focused release change, then tag the exact merge commit.
The full procedure is in [docs/agents/releases.md](docs/agents/releases.md).

macOS release builds are signed and notarized. Windows installers remain unsigned until Azure
Trusted Signing values are configured. Linux packages do not yet have detached signatures, an SBOM,
or provenance release checks. See [docs/windows-signing.md](docs/windows-signing.md).

## Verify changes

Use the fast local gate while iterating:

```bash
npm run check:fast
```

Run the full gate before a pull request:

```bash
npm run check
```

Run database suites against disposable PostgreSQL 16:

```bash
npm run test:db
```

Local packaging uses the side-by-side DEV identity:

```bash
npm run package:desktop
npm run package:desktop:appimage
npm run verify:desktop-package
```

Never commit generated `dist/`, `release/`, coverage, local databases, credentials, or installers.

## Continuous integration

GitHub Actions runs source checks and desktop package smoke. Woodpecker runs server checks, builds
the server image, and promotes it through the deployment repository. Tagged desktop-release jobs
publish production artifacts after package, signature, and release-notes checks pass.

## License

Hype Comms is [MIT-licensed](LICENSE). Contributions follow
[CONTRIBUTING.md](CONTRIBUTING.md).
