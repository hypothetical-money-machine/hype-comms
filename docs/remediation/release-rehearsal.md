# Release rehearsal

The remediation is not ready for production cutover until this rehearsal is complete. Keep the
candidate revision, compatible rollback revision, package checksums and backup/restore evidence in
one release record. A green pull-request package job alone does not establish a signed release,
installed upgrade, or safe production rollback.

The Kubernetes target, maintenance sequence, backup procedure and rollback rules are in
[the production cutover runbook](production-cutover.md). Its disposable server rehearsal checks a
separate protocol-2 rollback image against messages accepted after epoch activation.

## Repeatable checks

Run `npm run check` with the documented PostgreSQL and Python tools. It includes the memory and
persistent cache conformance tests, runtime loading and recovery tests, old-schema migrations,
accepted-send retry fixtures and the CLI-to-Python boundary. The CLI builds once before its test
files run; rebuilding in a parallel test used to remove files other suites were reading.

On a Linux host with `gnome-keyring`, `libsecret`, D-Bus and Xvfb, run:

```sh
bash scripts/rehearsal/linux-native-cache.sh
```

On macOS or Windows, run `npm run rehearse:native-cache`. These checks open three separate Electron
processes against a temporary synthetic profile. They use native `safeStorage`, Chromium IndexedDB,
the production cipher and the production cache migration. They abort an upgrade, verify the old
database, retry it, reopen it again, and compare the protected key files, encrypted outbox bytes,
original operation IDs and preferences. The check fails if native key protection is unavailable.
It removes only its own temporary profile. Linux always uses a separate D-Bus and test keyring.
Restricted Linux test hosts may set `HYPE_COMMS_REHEARSAL_NO_SANDBOX=1`; this option applies only to
the test process and is not part of desktop packaging.

Run `npm run rehearse:claude` on a desktop host with an installed, authenticated Claude executable.
On headless Linux, wrap it in `xvfb-run -a`. It opens a temporary workspace through the real Electron
utility worker, requests one fixed synthetic reply with no tools, closes the session and verifies
worker exit after idempotent disposal. It does not expose provider output or credentials. This uses
the normal local Claude authentication and may consume one provider request.

The scripts replace their previous success files before starting. Results are under
`.dev-data/rehearsal/`. Neither development-Electron check proves installation of the previous
production application, production signing identity continuity, or the installed updater path.

## Native candidate packages

Dispatch the existing **Desktop package smoke** workflow with `release_rehearsal=true` on the exact
candidate branch. This skips routine DEV packaging and runs the release package matrix on disposable
macOS, Windows and Linux runners. It uses production identity, API origin, platform notification
flags, ASAR/fuse checks, macOS signing/notarization and the existing Windows signing policy. Native
cache migration must pass on each runner. Package hashes and native-cache results accompany the
installers in seven-day Actions artifacts named by revision and platform.

The job has a read-only repository token. It creates no tag, GitHub Release or public update-feed
write. Existing Windows policy allows unsigned packages when no signing identity is configured;
a partial identity fails. Record that state as unsigned, never as Authenticode evidence. macOS
requires Developer ID and notarization. Notification rollout remains enabled only on macOS in this
matrix; the separate installed-notification evidence flow retains its existing platform scope.

These candidates retain the current desktop version for rehearsal only. They must not be
published over the existing version. Prepare the next unused stable version through the normal
release command after the stack is integrated, then rerun the package checks on that final revision.

The [2026-09-12 native record](evidence/native-rehearsal-2026-09-12.json) contains the successful
run at `e28770d`, package checksums verified against downloaded bytes, and each native-cache result.
It covers macOS, Windows and Linux ARM64 native storage, plus x64 and ARM64 packages on each OS.
macOS signatures and stapled notarization tickets passed; Windows was unsigned under the existing
policy. The earlier Linux/x64 native run is recorded in the decision trail.

The [server cutover record](evidence/server-cutover-2026-09-12.json) covers 35 restored table
fingerprints, attachment restoration and a separately built compatible server rollback retaining
post-cutover messages. Both records state their limits and do not establish production acceptance.

## Remaining acceptance before the maintenance window

For each supported platform, install the previous production package in a disposable OS user or VM.
Keep the production app identifier and updater configuration. Seed a synthetic signed-in scope,
protected cache, preferences and durable outbox; save in-memory composer drafts before restarting
an old client. Back up the complete local profile and prove that it can be reopened by the old build.

Exercise the installed update to the next unused candidate version using an isolated update-service
rehearsal. Verify update selection and signature policy, restart, native key access, retained pending
and already-accepted sends, drafts saved before restart, and preferences. A development Electron
profile or a manifest-only check cannot substitute for this test. Keep production user profiles and
the public update feed out of the rehearsal.

Restore the actual maintenance backup procedure into an isolated database and attachment volume.
Verify data, credentials and idempotency receipts before applying the additive migration. Activate
its new epoch with writers stopped, then exercise login, send/reply, attachments, tasks, reconnect
and retained outbox delivery against matching server, desktop, CLI and Hermes builds. Repeat with the
chosen protocol-2-compatible rollback build while retaining a message accepted after activation.
Do not restore a pre-cutover database over post-cutover writes.

The release record must also contain the general-agent/Hermes smoke, real Claude smoke, renderer
screenshots and keyboard/focus evidence, supported-platform package results, installed update
results, and a named operational owner for stopping writers and reopening service. The production
backup/attachment target and maintenance window must be confirmed before any production mutation.
