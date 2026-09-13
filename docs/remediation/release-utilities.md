# Release and command utilities

The desktop release dispatcher validates the tag, reviewed notes and main ancestry before exporting
its version. It loads this validator without npm dependencies because the workflow invokes it before
installation. Release preparation retains its coordination lock, worktree checks and rollback behavior.

Both signed macOS workflows use `macos-signing.mjs`. It saves the original keychain search list before
changing it, creates private certificate and API-key files, selects one identity for the expected team,
and exports only the values the package tools need. Cleanup restores the search list and removes the
job's credentials. If restoration fails, the original list remains for manual recovery. Temporary
filenames now use `hype-comms-` in both jobs; these are job scratch files, not application data.

Workflow tests parse YAML before inspecting triggers, job permissions, dependencies, signing conditions
and publication commands. Native signing and package verifiers remain required: injected native-command
tests establish ordering and failure behavior but cannot establish macOS trust or notarization.

Server pagination uses one bounded typed codec. Missing cursors request the first page; malformed
cursors return an invalid-input error, including the files endpoint that formerly restarted a listing.
Protocol-2 task cursors require their filter binding. CLI and administrative commands use Node's
argument tokenizer while retaining command-specific permissions and validation. Database-only rollback
commands share PostgreSQL URL and pool-size validation without requiring unrelated provider settings.

The environment example and Compose file now expose the humans-only and system-channel flags, both
false by default. The obsolete kustomize verifier and GitHub-asset polling command are removed. ARM64
package aliases and the external polling jobs are unchanged.

`npm run check` verifies these changes with PostgreSQL, Hermes, desktop and shared-package tests.
The macOS and Windows native release lanes remain part of the coordinated release rehearsal.
