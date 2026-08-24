# Desktop releases

How to cut a Hype Comms desktop release. Follow this file when the user asks to run, cut, or
prepare a release. Do not rediscover the sequence from git history or a previous chat.

The notes scaffold, review marker, and file-format rules live in
[docs/releases/README.md](../releases/README.md). The public feed, signing secrets, and withdraw
procedure live in the root [README](../../README.md) under **Desktop releases and updates**. This
file is the agent runbook.

## What a release is

A release is a focused version bump on `main`, then a `v<version>` tag on that exact revision.
The tag starts `.github/workflows/desktop-release.yml`, which packages, signs, notarizes, verifies,
publishes installers to `https://updates.hypemm.com/desktop`, and creates the GitHub Release.

`npm run release` only prepares files. It never commits, tags, pushes, or publishes.

## Preconditions

1. `git fetch origin --tags` and update from `origin/main`.
2. Work on a short-lived branch from that tip. The worktree must have no unrelated changes;
   `npm run release` rejects them.
3. Use Node 24.18.x and npm 11.16.x. If `node_modules` is missing, `npm ci` from the lockfile.
4. Confirm the current desktop version in `apps/desktop/package.json` and that `v<current>` already
   exists. The next patch is current + 1 unless the user named a different stable version.
5. Confirm that the release workflow's `HYPE_COMMS_API_ORIGIN` names the deployed HTTPS API.
   Production packaging rejects a missing value or a `.invalid` host.

## Prepare

```bash
npm run release -- 0.1.27
```

That command updates `apps/desktop/package.json` and the matching `package-lock.json` workspace
entry, and creates `docs/releases/v<version>.md` if it does not exist. Re-running the same target
preserves a nonempty notes file. Omitting the version is an error and prints the suggested next
patch without changing files.

Do not hand-edit the version in other manifests.

## Write notes from every merge since the last tag

Reviewed notes are written from **every merge on `main` since the previous desktop tag**, not from
the single most visible feature.

```bash
git log --merges --format='%h %s' v<previous>..origin/main
gh pr view <n>
```

Walk that list, then fill `docs/releases/v<version>.md`:

- Every user-visible behavior change and important fix goes in **Highlights** or **Fixes**. Two
  features from two PRs means two Highlights.
- Keep **Known limitations** and required manual actions that apply to those changes.
- Drop empty sections.
- Omit internal delivery work from the reviewed file: dependency bumps, docs-only changes,
  CI/release plumbing, and the version-bump PR itself. GitHub's generated **What's Changed**
  section still lists those PRs.
- A merge that is mostly internal still gets a line if it has user-visible behavior. A merge with
  none is omitted from the reviewed file, not from the inventory.

Replace the scaffold bullets and remove the `release-notes:todo` marker. The workflow rejects a
missing, empty, or still-marked notes file.

Write for someone deciding whether to install. Do not write notes from memory of the largest PR or
the current conversation. If the merge list is empty, say so and do not invent Highlights.

## Check

Run `npm run check`. On a machine that can package, explicitly select the production identity for
both the native package and its verification:

```bash
HYPE_COMMS_API_ORIGIN="$production_api_origin" HYPE_COMMS_BUILD_FLAVOR=production npm run package:desktop
HYPE_COMMS_API_ORIGIN="$production_api_origin" HYPE_COMMS_BUILD_FLAVOR=production npm run verify:desktop-package
```

Also run `npm run verify:desktop-package:macos-release` on a signed macOS host, and
`npm run verify:desktop-package:windows-release` on a signed Windows host after the Azure Trusted
Signing secrets in [docs/windows-signing.md](../windows-signing.md) exist. Production Windows
packaging stays unsigned until those values exist, then fail-closes. The release workflow is the
real packaging gate; do not block the prep PR on a full local installer if this host cannot build
one.

The prep PR must be green before merge. The PostgreSQL CI job can occasionally time out on
`bot-cli` / `migrate` when the self-hosted runner is busy. Rerun the failed job; do not change
timeouts inside the version-bump PR.

## Land, then tag

1. Commit only the three release-owned paths: `apps/desktop/package.json`, `package-lock.json`,
   and `docs/releases/v<version>.md`.
2. Title: `chore(release): prepare Hype Comms <version>`.
3. Open a PR to `main`. The PR does not change renderer UI; Screenshots is `N/A` and can point at
   feature-PR evidence already on `main`.
4. Merge with a **merge commit**, not squash. Previous releases tag the merge revision.
5. After the merge is on `origin/main`, create a lightweight tag on that commit and push it:

   ```bash
   git fetch origin
   git tag v<version> <merge-commit>
   git push origin v<version>
   ```

Do not tag the PR branch tip if `main` will have a merge commit. The workflow rejects a tag that
does not exactly match the desktop package version.

## Confirm publication

Watch the **Desktop release** workflow for `v<version>` until every job succeeds: validate,
prepare GitHub Release, Release Linux / macOS / Windows, Publish GitHub Release.

Then verify:

- `gh release view v<version>` is published (not a draft) and the body starts with the reviewed
  notes.
- `https://updates.hypemm.com/desktop/latest.yml`, `latest-mac.yml`, `latest-linux.yml`, and
  `latest-linux-arm64.yml` all name this version.

Installed clients on the previous version auto-update from that feed. GitHub Release assets are
the manual-download archive.

## Do not

- Leave the review marker in the notes.
- Commit `dist/`, `apps/desktop/release/`, credentials, or installers.
- Republish an existing version. Artifacts are cached immutable; a bad release is withdrawn by
  re-uploading the previous `latest*.yml` files last, then shipping a newer forward-fix.
- Redirect the update feed. Its URL is baked into the package.
- Expand the release PR with unrelated fixes or timeout changes.
