# Repository guidelines

## Project structure and modules

Hype Comms is an npm-workspaces TypeScript monorepo. `apps/desktop` contains the Electron
main, preload, React renderer, and shared IPC types. `apps/server` contains the Fastify HTTP
and WebSocket service. `packages/contracts` is the source of truth for strict Zod wire
schemas shared by both apps. Tests live beside desktop source as `*.test.ts` or in each
workspace's `test/` directory. Product strategy and delivery work live in GitHub Issues;
implementation behavior is defined by source, shared contracts, and tests. Packaging checks
live in `scripts/`. Do not edit or commit generated `dist/`, `release/`, `coverage/`, or
`node_modules/` content.

## Platform-scoped delivery

A feature, fix, issue, or pull request may target one platform or a named subset. Preserve the
existing behavior on the other platforms. Require cross-platform parity only when acceptance
criteria or a shared security, data, wire-contract, migration, or release-safety invariant
requires it. Otherwise:

- preserve existing behavior on platforms outside the stated scope;
- use capability detection, a platform condition, or a default-off gate where needed;
- document the supported platform scope and any user-visible limitation; and
- run shared tests plus the native package or evidence lanes relevant to the changed platforms.

The full release matrix checks each platform's intended behavior. Native-notification evidence is
platform-scoped.

## Build, test, and development

Use Node 24.18.x and npm 11.16.x. Install from the lockfile with `npm ci`.

- `npm run dev`: start the Fastify server and Electron client together.
- `npm run dev:server` / `npm run dev:desktop`: run one workspace in watch mode.
- `npm run check`: run Prettier checks, ESLint, TypeScript, Vitest, and workspace builds.
- `npm test`: run all workspace tests once.
- `npm run package:desktop`: create native desktop packages.
- `npm run package:desktop:appimage`: build only the Linux AppImage.
- `npm run verify:desktop-package`: inspect packaged ASAR contents and Electron fuses.

## Coding style and naming

Use two-space indentation, LF endings, UTF-8, and a 100-column Prettier width. TypeScript
uses double quotes, semicolons, trailing commas, explicit type-only imports, and no `any`.
Use PascalCase for React components/types, camelCase for functions and variables, and
`*.test.ts` for tests. Server and contracts are ESM; relative imports use `.js` specifiers.
Keep the renderer unprivileged: no Node APIs, credentials, or direct product networking.
Validate every external, IPC, and realtime boundary with strict schemas.

## Testing

Vitest is the unit-test framework. Add regression tests with behavior changes, especially
for IPC validation, authorization, configuration, and wire contracts. Target a workspace
with `npm test --workspace @hype-comms/server -- config.test.ts`. Run `npm run check` before
every pull request; desktop packaging changes also require the relevant native smoke job.

## Version control

This checkout is a plain Git repository with an `origin` remote on GitHub.

- Inspect work with `git status` and `git log`.
- Update from the remote with `git fetch`, then rebase or merge as appropriate.
- Branch for work you intend to publish; `main` is the default branch and changes land through
  pull requests.
- Before publishing, inspect `git diff` and run the relevant checks. Keep commits focused and use
  the Conventional Commit format below.

## Commits and pull requests

Follow the existing Conventional Commit style: `feat(scope): ...`, `fix: ...`,
`refactor(server): ...`, or `docs: ...`. Keep commits focused and imperative. Codex-created
commits append `Co-authored-by: Codex <codex@openai.com>` after a blank line. Pull requests
must explain motivation and user-visible behavior, list verification, note security or
compatibility impact, link relevant issues, and include screenshots for renderer changes.
Never commit credentials, signing material, real message data, local databases, or installers.

### Renderer review evidence

Any change under `apps/desktop/src/renderer/`, or any desktop change that visibly changes the UI,
must be accompanied by a screenshot before the work is considered complete. Run the relevant
desktop/demo flow, capture the actual changed state (including the important interaction state when
applicable), save reusable evidence under `docs/screenshots/`, and embed it in the pull request's
Screenshots section with a short caption. If the app cannot be launched or the state cannot be
captured, report that as a blocker. Do not omit the screenshot or defer it to review.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root. See `docs/agents/domain.md`.

### Desktop releases

How we cut a desktop release, including notes from every merge since the last tag. See
`docs/agents/releases.md`.
