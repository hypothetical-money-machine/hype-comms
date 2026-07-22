# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HMM Chat is a desktop-first, server-authoritative realtime team chat product for a bounded
private pilot (one hosted workspace, ≤25 people). It is an npm-workspaces TypeScript monorepo
in its **foundation milestone**: the secure Electron shell, shared wire contracts, and a Fastify
bootstrap exist, but most product features (auth, messages, sync, search, files) are not yet
built. `docs/architecture.md` describes the _target_ system, not what the code currently does.

The repository was previously a Go WebSocket server + Bubble Tea TUI; that history is preserved
at the tag `prototype-go-tui-2025-11-30` and is not part of the current build.

## Commands

Node is pinned via `.nvmrc`/`.node-version` (24.18.x, npm 11.16.x). Use `fnm`/`nvm` to match.

```bash
npm ci                    # install (use ci, not install — lockfile is authoritative)
npm run dev               # run server + desktop concurrently
npm run dev:server        # server only (tsx watch)
npm run dev:desktop       # desktop only (electron-vite dev)
npm run check             # full gate: format:check + lint + typecheck + test + build
npm test                  # run all workspace tests once
npm run build             # build all workspaces
npm run package:desktop   # electron-builder installers (see native-packaging note below)
```

`npm run check` is the CI gate — run it before considering work done. It runs Prettier,
ESLint (`--max-warnings=0`), `tsc`, Vitest, and production builds across every workspace.

### Running a single test

Tests use Vitest. Target one workspace and file/name:

```bash
npm test --workspace @hmm-chat/server -- config.test.ts
npm test --workspace @hmm-chat/desktop -- -t "blocks navigation"
```

`--workspace @hmm-chat/{server,desktop,contracts}` selects the package; args after `--` pass
through to `vitest run` (a file substring, or `-t <name pattern>`).

## Workspace layout and build ordering

- `packages/contracts` — versioned strict **Zod** schemas + inferred types for HTTP, IPC, and
  realtime wire shapes. **This is the single source of truth for every wire boundary.** Server
  and desktop both depend on `@hmm-chat/contracts`; changing a wire shape means changing a schema
  here first. It compiles to `dist/`, and `server`/`contracts` builds emit real output that
  downstream packages consume — server scripts have `pre*` hooks that build contracts first, so a
  stale `contracts/dist` causes confusing type errors. When editing contracts, rebuild it.
- `apps/server` — Fastify 5 HTTP/WebSocket service, ESM (`"type": "module"`, `.js` import
  specifiers required). Entry `src/main.ts` → `buildApp()` in `src/app.ts`. Routes live under
  `src/modules/<domain>/routes.ts` and are registered under a `/v1` prefix. Config is parsed and
  validated from `HMM_*` env vars in `src/config.ts` (fails fast on bad input); prefer adding
  config there over reading `process.env` elsewhere.
- `apps/desktop` — Electron (main/preload/renderer) + React 19, built by `electron-vite`. The
  three processes share code only through `src/shared/` and communicate only through the typed
  IPC facade.

## Architecture invariants (do not violate without an architecture change)

These are enforced in code and load-bearing for the security model. `docs/architecture.md` is the
binding decision record; treat changes to the following as architecture changes requiring review.

**Desktop process boundaries.** The renderer is untrusted UI: no Node/Electron imports, no
credentials, no direct network. All privileged work (networking, tokens, notifications) happens in
**main**; the **preload** exposes a frozen, typed request/response facade over an allowlisted set
of IPC channels (`src/shared/channels.ts`) with runtime validation on every message. When adding
an IPC channel you must: add it to `DESKTOP_CHANNELS`, add a typed method to `DesktopApi`
(`src/shared/desktop-api.ts`), validate the sender in main via the `isTrustedIpcSender` check, and
validate the payload in preload before handing it to the renderer. Never pass raw channel names,
URLs, or Electron objects through preload.

**Locked-down windows.** Every `BrowserWindow` runs with `contextIsolation`, `sandbox`,
`nodeIntegration: false`, and `webSecurity: true`. Navigation and window-open are denied;
allowlisted `https:` links open in the system browser only after passing the URL validators in
`src/main/security.ts`. Session permissions and downloads are denied wholesale. The CSP is defined
in `src/shared/security-policy.ts` (production is `default-src 'none'` with `connect-src 'self'`,
because only main does product networking) — do not loosen it to make renderer code work; move the
work to main instead. `src/main/security.test.ts` asserts these invariants.

**Build-time API origin / CSP injection.** The API origin and production CSP are injected as
compile-time globals (`__HMM_CHAT_API_ORIGIN__`, `__HMM_CHAT_PRODUCTION_CSP__`) via `define` in
`electron.vite.config.ts`, validated at build time by the normalizers in `src/shared/api-origin.ts`.
They are not runtime-configurable in the renderer. The renderer's HTML CSP placeholder is
substituted by a Vite plugin. Declared for TS in `src/main/build-globals.d.ts`.

**Realtime is a hint, not truth.** WebSocket delivery is never durable state. The realtime
handshake uses a single-use, short-lived HTTP-issued **ticket** (bound to member+session, passed
as a query param) to authorize the WSS upgrade — bearer/refresh credentials never appear in
WebSocket headers, URLs, or subprotocols. Server-side realtime lives in
`apps/server/src/modules/realtime/`.

**Server never trusts client identity.** Workspace/user IDs from the client are not trusted;
authorization and conversation visibility are re-checked server-side on every request. Errors use
the shape `{ error: { code, message, requestId, details? } }` (see `src/errors.ts`) and must not
leak stack traces, SQL, tokens, or email-existence hints.

## Conventions

- **ESM everywhere.** Server and contracts are `"type": "module"`; use `.js` specifiers in
  relative imports (e.g. `import { buildApp } from "./app.js"`) even though sources are `.ts`.
- **Strict schemas at boundaries.** Parse untrusted input (HTTP bodies, IPC payloads, env,
  realtime frames) through a Zod schema from `@hmm-chat/contracts` (or a local `.strict()` schema
  for server-internal config). Reserved schema values (e.g. `group_direct_message`, `editedAt`)
  exist in the contracts but are **not** reachable pilot behavior — the server rejects them.
- **Large integers as strings.** Sequence/byte-count values that can exceed JS safe-integer range
  cross JSON as decimal strings. IDs are UUIDs (UUIDv7 where ordering helps); timestamps are UTC
  RFC 3339 strings.
- Formatting/linting are non-negotiable gates (`--max-warnings=0`); run `npm run format` to fix.

## Native packaging note

`npm run package:desktop` builds signed-artifact-shaped installers via `electron-builder`. On
Linux the Debian target needs a `libcrypt.so.1` compatibility library (`libxcrypt-compat` on
Arch/CachyOS); the AppImage target does not — use `npm run package:desktop:appimage` to skip it.
The **native GitHub Actions packaging jobs are the canonical smoke test** for installers; local
packaging is best-effort. `scripts/verify-desktop-package.mjs` (`npm run verify:desktop-package`)
checks a produced package. Artifacts land in `apps/desktop/release/`.
