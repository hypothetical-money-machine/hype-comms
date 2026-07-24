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

## Development

```bash
npm ci
npm run dev -- --name Morgan
```

The temporary development identity is supplied by `--name`. The `#welcome` channel works
across connected clients, but its in-memory history resets whenever the server restarts.
With the first client still running, open a second terminal and join the same local channel
under another identity:

```bash
npm run dev:join -- --name Alex
```

Run one process at a time with `npm run dev:server` or set `HMM_CHAT_NAME` and run
`npm run dev:desktop`.

## Weekend dogfood deployment

The server can run as a container for a small, access-code-protected dogfood deployment. This
path is deliberately temporary: it predates the M1 invitation and session work in
[ROADMAP.md](ROADMAP.md) and is expected to be deleted rather than grown.

```bash
cp .env.example .env
# set HMM_DOGFOOD_ACCESS_CODE, e.g. openssl rand -base64 24
docker compose up --build -d
```

Compose refuses to start without `HMM_DOGFOOD_ACCESS_CODE`, so there is no insecure default. The
container publishes only on `127.0.0.1`, expecting a reverse proxy or tunnel on the same host to
terminate TLS. It runs as a non-root user with a read-only root filesystem and all capabilities
dropped.

`HMM_PUBLIC_API_URL` must be HTTPS when `NODE_ENV=production`, and it also decides whether session
cookies carry `Secure`. Chat history and the session signing key live in the `chat-data` volume at
`/data`; deleting that volume clears history and signs everyone out.

Verify a built image end to end, including persistence across a restart:

```bash
docker build -t hmm-chat-server:smoke --target runtime .
scripts/smoke-container.sh hmm-chat-server:smoke
```

### Dogfood authentication model

Everyone shares one access code. Signing in issues an HTTP-only, `SameSite=Strict` cookie signed
with a 32-byte key generated on first boot and stored in the SQLite database, so restarts do not
sign users out and knowing the access code is not enough to forge a session for another name.
Rotating the access code invalidates every outstanding session. Failed sign-in attempts are
throttled per client address.

Because the access code is shared, this gives no per-person identity, revocation, or audit trail.
It suits two cofounders behind a private URL and nothing beyond that.

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
