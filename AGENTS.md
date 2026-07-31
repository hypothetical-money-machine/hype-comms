# Repository Guidelines

## Project Structure & Module Organization

Hype Comms is an npm-workspaces TypeScript monorepo. `apps/desktop` contains the Electron
main, preload, React renderer, and shared IPC types. `apps/server` contains the Fastify HTTP
and WebSocket service. `packages/contracts` is the source of truth for strict Zod wire
schemas shared by both apps. Tests live beside desktop source as `*.test.ts` or in each
workspace's `test/` directory. Architecture and delivery decisions are in
`docs/architecture.md` and `ROADMAP.md`; packaging checks live in `scripts/`. Do not edit or
commit generated `dist/`, `release/`, `coverage/`, or `node_modules/` content.

## Build, Test, and Development Commands

Use Node 24.18.x and npm 11.16.x, then install exactly from the lockfile with `npm ci`.

- `npm run dev`: start the Fastify server and Electron client together.
- `npm run dev:server` / `npm run dev:desktop`: run one workspace in watch mode.
- `npm run check`: run Prettier checks, ESLint, TypeScript, Vitest, and production builds.
- `npm test`: run all workspace tests once.
- `npm run package:desktop`: create native desktop packages.
- `npm run package:desktop:appimage`: build only the Linux AppImage.
- `npm run verify:desktop-package`: inspect packaged ASAR contents and Electron fuses.

## Coding Style & Naming Conventions

Use two-space indentation, LF endings, UTF-8, and a 100-column Prettier width. TypeScript
uses double quotes, semicolons, trailing commas, explicit type-only imports, and no `any`.
Use PascalCase for React components/types, camelCase for functions and variables, and
`*.test.ts` for tests. Server and contracts are ESM; relative imports use `.js` specifiers.
Keep the renderer unprivileged: no Node APIs, credentials, or direct product networking.
Validate every external, IPC, and realtime boundary with strict schemas.

## Testing Guidelines

Vitest is the unit-test framework. Add regression tests with behavior changes, especially
for IPC validation, authorization, configuration, and wire contracts. Target a workspace
with `npm test --workspace @hmm-chat/server -- config.test.ts`. Run `npm run check` before
every pull request; desktop packaging changes also require the relevant native smoke job.

## Version Control (Git)

This checkout is a plain Git repository with an `origin` remote on GitHub.

- Inspect work with `git status` and `git log`.
- Update from the remote with `git fetch`, then rebase or merge as appropriate.
- Branch for work you intend to publish; `main` is the default branch and changes land through
  pull requests.
- Before publishing, inspect `git diff` and run the relevant checks. Keep commits focused and use
  the Conventional Commit format below.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style: `feat(scope): ...`, `fix: ...`,
`refactor(server): ...`, or `docs: ...`. Keep commits focused and imperative. Codex-created
commits append `Co-authored-by: Codex <codex@openai.com>` after a blank line. Pull requests
must explain motivation and user-visible behavior, list verification, note security or
compatibility impact, link relevant issues, and include screenshots for renderer changes.
Never commit credentials, signing material, real message data, local databases, or installers.
