# HMM Chat

HMM Chat is a desktop-first team chat product for a private Hypothetical Money Machine
pilot. The first release targets macOS, Windows, and Linux with an Electron client and a
server-authoritative realtime backend.

The repository is in its foundation milestone: it contains the secure desktop shell,
shared wire contracts, and API bootstrap—not a feature-complete chat service yet. See
[ROADMAP.md](ROADMAP.md) for delivery milestones and [docs/architecture.md](docs/architecture.md)
for the implementation contract.

## Repository layout

```text
apps/desktop       Electron + React desktop client
apps/server        Fastify HTTP/WebSocket service
packages/contracts Versioned Zod schemas and shared TypeScript types
docs               Architecture and security decisions
```

## Prerequisites

- Node.js 24.18.x (LTS)
- npm 11.16.x

Native desktop packaging also needs the host platform's packaging tools. In particular,
Debian package creation through electron-builder requires a `libcrypt.so.1` compatibility
library; the native GitHub Actions packaging jobs are the canonical smoke test.

The repository pins the expected runtime in `.node-version` and `.nvmrc`.

### CachyOS / Arch Linux

Install the Node version manager and the legacy crypt library needed by electron-builder's
Debian packager, then use the repository-pinned Node release:

```bash
sudo pacman -S --needed fnm libxcrypt-compat
eval "$(fnm env)"
fnm install 24.18.0
fnm use 24.18.0
npm ci
npm run check
npm run package:desktop
npm run verify:desktop-package
```

The AppImage does not need the `libcrypt.so.1` compatibility layer to build. To produce only
that artifact, run `npm run package:desktop:appimage` instead of `npm run package:desktop`.
Artifacts land in `apps/desktop/release/`.

## Joining the pilot

If you just want to use HMM Chat against the running pilot server, this is the whole procedure.
You do **not** need Docker, Postgres, a local server, or any of the local-development setup below.

```bash
fnm install 24.18.0 && fnm use 24.18.0    # the repository pins this; npm refuses other versions
npm ci
HMM_CHAT_API_ORIGIN=https://chat-api.example.invalid npm run dev:desktop
```

The client opens a sign-in screen offering two ways in:

- **Sign-in link.** Ask an administrator to run the invite command for your email address. They
  send you the link privately; opening it hands the token to this app and signs you in. This is the
  real per-person identity: your own account, your own sessions, revocable per device.
- **Access code.** The shared code that predates per-person accounts. Ask an administrator for it.
  Everyone using it shares one credential, so prefer a sign-in link where you have one.

The API origin is read when the client builds, so restart after changing it. A development build
accepts a loopback HTTP origin or any HTTPS origin; plain HTTP to a remote host is refused, because
that is the case where your credentials would cross the network in the clear.

## Development

Everything below is for working **on** HMM Chat, and runs a server on your own machine. Skip it if
you only want to use the pilot.

```bash
npm ci
npm run dev -- --name Morgan
```

Development runs the same authenticated path as a deployment: the client opens a sign-in screen
and the server derives every message author from the session. `--name` only pre-fills the sign-in
form. The local access code is printed on startup and is also the fixed value
`local-development-access-code`.

History is persisted to `.dev-data/hmm-chat.sqlite`, which is git-ignored. Delete that directory
to start from an empty channel.

With the first client still running, open a second terminal and join as another person:

```bash
npm run dev:join -- --name Alex
```

Run one process at a time with `npm run dev:server` or set `HMM_CHAT_NAME` and run
`npm run dev:desktop`.

### Pointing the desktop client at a deployment

`HMM_CHAT_API_ORIGIN` selects the server the client talks to. A development build accepts a
loopback HTTP origin or any HTTPS origin, so it can be aimed at a real deployment:

```bash
npm run dev:server                                   # not needed when using a remote server
HMM_CHAT_API_ORIGIN=https://chat-api.example.invalid npm run dev:desktop
```

The origin is read when the client is built, so restart `dev:desktop` after changing it. Plain
HTTP to a non-loopback host is rejected: that is the case where the access code and session cookie
would cross the network in the clear.

## Container deployment

The server runs as a container. The pilot deployment runs the identity model described below,
alongside the shared access code that predates it.

```bash
cp .env.example .env
# set HMM_CHAT_ACCESS_CODE, e.g. openssl rand -base64 24
docker compose up --build -d
```

Compose refuses to start without `HMM_CHAT_ACCESS_CODE`, so there is no insecure default. The
container publishes only on `127.0.0.1`, expecting a reverse proxy or tunnel on the same host to
terminate TLS. It runs as a non-root user with a read-only root filesystem and all capabilities
dropped.

## Running the identity model without an email provider

Identity features register only when `HMM_DATABASE_URL` is set. The server applies its own
migrations at boot, so no separate migration step is needed for a normal deploy.

Magic-link sign-in normally needs SMTP. To run a real deployment before choosing an email
provider, set `HMM_EMAIL_DELIVERY=manual`: an administrator issues sign-in links with the invite
command and passes them along privately. In that mode `POST /v1/auth/magic-link` is refused with a
503 rather than accepted and silently dropped, so nobody waits on an email that was never going to
arrive. The refusal is identical for every address, so it reveals nothing about who is a member.

Required environment for an identity deployment:

```bash
HMM_DATABASE_URL=postgres://…      # enables identity
HMM_EMAIL_DELIVERY=manual          # or configure HMM_SMTP_URL and HMM_EMAIL_FROM
HMM_OWNER_EMAIL=you@example.com    # seeded once, on first boot
```

Invite someone, then send them the printed link over a private channel:

```bash
# in a container, where only the compiled output exists
npm run invite:dist --workspace @hmm-chat/server -- --email them@example.com

# from a source checkout
npm run invite --workspace @hmm-chat/server -- --email them@example.com
```

Re-running for the same address reuses the pending invitation and issues a fresh link, which is
what you want when the previous one expired. Links last 15 minutes; invitations last 7 days.

With compose, Postgres sits behind an opt-in profile: set `HMM_POSTGRES_PASSWORD` and
`HMM_DATABASE_URL` in `.env`, then `docker compose --profile identity up -d`.

`HMM_PUBLIC_API_URL` must be HTTPS when `NODE_ENV=production`, and it also decides whether session
cookies carry `Secure`. Chat history and the session signing key live in the `chat-data` volume at
`/data`; deleting that volume clears history and signs everyone out.

Verify a built image end to end, including persistence across a restart:

```bash
docker build -t hmm-chat-server:smoke --target runtime .
scripts/smoke-container.sh hmm-chat-server:smoke
```

### Authentication model

Two credentials are accepted while the pilot moves off the shared code. A request presenting both
is treated as the access code.

**Sign-in links (per-person identity).** An owner invites an email address; redeeming a single-use
link creates that person's own account and a rotating device session. Links last 15 minutes and
burn on the first redemption attempt, invitations last 7 days, and sessions can be revoked per
device. Only an owner may invite, the workspace is capped at 25 active members, and redeeming an
invitation never lowers the privileges of a membership that is already active. Sign-in requests
answer identically for invited, unknown, and rate-limited addresses, so the endpoint cannot be used
to discover who is a member.

**The shared access code (predates the above).** Signing in issues a cookie signed with a 32-byte
key generated on first boot and stored beside the messages, so restarts do not sign anyone out and
knowing the access code is not enough to forge a session under another name. Rotating the code
invalidates every outstanding session. It gives no per-person identity, revocation, or audit trail,
and exists only until everyone has moved to sign-in links.

Either way the desktop client holds the session entirely in the Electron main process. A magic-link
token and an access code both cross IPC only for the duration of a sign-in call and are never
stored; cookies live in Electron's cookie jar, which the packaged app encrypts through the
`enableCookieEncryption` fuse. Renderer code can observe whether a session exists, under what name,
and by which method — and nothing more. Signing in one way clears the other credential, so a person
is never authenticated two ways at once.

## Verification

```bash
npm run check
npm run package:desktop
```

`check` runs formatting, linting, type checks, unit tests, and production builds across all
workspaces. Desktop installers must also be exercised on native macOS, Windows, and Linux
runners before release.

## Prototype history

The original Go WebSocket server and Bubble Tea client remain recoverable at the annotated
tag `prototype-go-tui-2025-11-30`. The Electron-first rebuild continues on `main` without
rewriting that history.

## Status and scope

The pilot is intentionally bounded to one invited workspace and up to 25 people. Its core
scope is channels, 1:1 direct messages, threads, reactions, mentions, unread state, file
attachments, search, native notifications, and reconnect-safe offline sends. Voice/video,
bots, workflow automation, enterprise identity, federation, mobile clients, and Slack import
are deferred until pilot evidence justifies them.

This is a private, unlicensed repository. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before making changes.
