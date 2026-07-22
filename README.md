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
npm run dev
```

Run one process at a time with `npm run dev:server` or `npm run dev:desktop`.

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
