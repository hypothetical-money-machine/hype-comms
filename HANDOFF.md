# Handoff — 2026-07-25

Transient note for whoever picks up next. Delete it once it stops being true.

`main` is at the merge of three changes landed on top of M2. `npm run check` and
`npm run test:db` both pass on `main` as of this writing.

## Read this first: CI is red, and it is not the code

Every GitHub Actions job fails within a few seconds with:

> The job was not started because recent account payments have failed or your spending limit
> needs to be increased.

**Do not debug the workflows.** They were green earlier in the day and the failure is account
billing, which only the repository owner can fix. A red `verify` job right now says nothing about
your change. Verify locally instead:

```bash
npm run check      # the full gate CI would run
npm run test:db    # the five database-gated suites, needs Docker
```

Woodpecker is self-hosted and unaffected, so server builds and deploys still work.

## What landed tonight

- **An auto-updating desktop client.** Packaged production builds check an HTTPS feed, download in
  the background, and install on restart or normal quit. The updater lives in the Electron main
  process (`apps/desktop/src/main/updater.ts`) and reports a strict, renderer-safe state over IPC.
- **A release pipeline** (`.github/workflows/desktop-release.yml`) triggered by a `v*` tag. It
  packages on native runners, signs and notarizes on macOS, verifies, then publishes to a
  self-hosted S3-compatible storage bucket served at `updates.hypemm.com`.
- **A download page** (`downloads/index.html`), published to the bucket root by the release
  workflow. It reads the published manifests at load time, so it cannot disagree with what was
  actually uploaded.
- **`npm run test:db`**, which runs five previously-skipped server suites against a disposable
  PostgreSQL. Server tests went from 25 passed / 33 skipped to 58 passed / 0 skipped. If you touch
  identity, sessions, membership, workspace authorization, or migrations, run it — `npm run check`
  alone silently skips all of that.

## Environment gotchas that will cost you time

- **Node must be exactly 24.18.0.** `.npmrc` sets `engine-strict=true`, so `npm ci` hard-fails on
  anything else with an error that does not point at the fix. `eval "$(fnm env)" && fnm use 24.18.0`.
- **`npm run test:db` needs Docker running.** It fails with one clear sentence if not.
- **Port 5173 is `strictPort`.** A stale desktop dev process blocks `npm run dev:desktop`; the
  preflight now names the port rather than failing cryptically. Do not make it fall back to another
  port — the trusted-origin checks in `security.ts` are pinned to it.
- **`AGENTS.md` and `CLAUDE.md` describe a Jujutsu workflow, but `jj` is not installed and there is
  no `.jj` directory.** This checkout is plain git. Those instructions are stale.
- **`apps/desktop/release/` is gitignored and can reach ~1 GB.** Never commit it.
- **macOS ships bash 3.2.** Signal handling in shell scripts behaves differently than bash 5; a
  trap that looks correct on Linux may not fire here. Test interrupts, do not reason about them.

## Invariants — please do not weaken these

The updater is a remote code execution channel by design. Several guards exist because a review
found the corresponding hole:

- **The update feed URL is baked at package time.** There is deliberately no env var, argument, or
  config file that can redirect an installed client at another server.
- **Releases publish only from a tag** whose name matches the desktop package version, and the
  workflow refuses to republish an existing version. Both guards are load-bearing: a
  `workflow_dispatch` from a branch previously bypassed validation entirely, and republishing a
  version breaks every client because artifacts are cached immutable while manifests are not.
- **Renderer-facing updater errors are an allowlist of three strings**, enforced by a Zod `refine`
  in `packages/contracts/src/update.ts`. Raw electron-updater messages embed feed URLs and local
  paths and must not cross IPC.
- **`scripts/verify-macos-release.mjs` must keep gating the release.** electron-builder only _warns_
  when signing or notarization is skipped, so without this a release can go green having shipped an
  unsigned build.
- Renderer stays unprivileged; every external, IPC, and realtime boundary keeps its strict Zod
  validation.

## Known open items

- **The DMG container is not notarized** — only the app inside it. Gatekeeper accepts the app
  (`accepted / Notarized Developer ID`, verified on both architectures), but `spctl` rejects the
  DMG. Impact on a fresh browser download is untested; downloading the first published DMG settles
  it. Fix, if needed, is notarizing the DMG via an `afterAllArtifactBuild` hook.
- **Windows installers are unsigned.** Updates there rest on HTTPS plus the manifest checksum
  rather than an independent signature, because electron-updater skips Authenticode verification
  when no publisher name is recorded. macOS has both. Closing it needs a Windows certificate.
- **`scripts/test-database.sh` exit code on interrupt** is correct in the main window but can still
  report 0 if the interrupt lands where npm absorbs the signal after the suite finished. Cleanup is
  reliable in every tested path; no container leaks.
- **Two Dependabot PRs are open and deliberately unmerged** (#1 bumps `actions/upload-artifact` and
  conflicts with a workflow change made tonight; #3 bumps six dev dependencies). Neither can be
  verified while CI is down. Merge them once billing is fixed and CI is green.

## Next steps, once billing is fixed

1. Re-run the checks on `main` and confirm green.
2. Cut a throwaway `v0.1.1` tag. Windows packaging, Linux packaging, and the S3-compatible storage upload have
   never executed; better to find problems on a tag nobody is waiting for.
3. Then the real release. macOS signing and notarization were verified end to end locally against
   Apple's notary service, so that half is known good.

Note that the first signed macOS build cannot be reached by auto-update: an unsigned running app
has no signature for Squirrel to validate against. Both existing macOS installs need one manual
install, and everything after that is automatic.
