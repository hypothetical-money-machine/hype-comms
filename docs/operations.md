# Pilot operations

This is the operational contract for the deployment that exists today. The AWS/Cloudflare design
in `docs/architecture.md` is a hosted target, not the current topology.

## Delivery ownership

- GitHub pull requests run native desktop package smoke. The `CI` workflow also runs the complete
  source gate and all PostgreSQL integration tests on an isolated job-scoped PostgreSQL 16 cluster.
- A push to `main` runs `.woodpecker.yml`: source checks plus `npm run test:postgres` against its
  PostgreSQL 16 service, an immutable-SHA server image build into
  `registry.example.invalid/example-project/hype-comms`, then a GitOps image promotion in
  `hype-comms/deployment-repository` for the `production-cluster` cluster.
- A `v*` tag on `main` must exactly match `apps/desktop/package.json` and have nonempty, reviewed
  notes at `docs/releases/v<version>.md`. Prepare those files with
  `npm run release -- <version>`; aside from an ephemeral local Git lock that serializes concurrent
  preparation, the command only inspects Git and performs no commit, branch, tag, remote, or
  publication operation. Native
  release jobs package and publish platform artifacts and the platform manifest to the S3-compatible storage update
  bucket, then attach the verified installers, blockmaps, updater manifests, and release notes to a
  Hype Comms GitHub Release for that tag. The workflow refuses to publish a body that does not
  contain the reviewed notes.
- Kubernetes manifests, ingress/TLS, database lifecycle, secret injection, Argo CD health, backup
  scheduling, and production rollback are owned by `deployment-repository`. A release review must link
  evidence from that repository rather than assuming these controls from application code.

The Woodpecker build depends on the database-backed check, promotion depends on that exact image
build, and workflow concurrency is one. Overlapping `main` runs therefore cannot promote an older
SHA after a newer one. Local `npm run test:db` and GitHub CI invoke the same guarded entrypoint; it
refuses missing URLs and databases whose names are not explicitly test-only.

## Service checks and metrics

- `GET /livez` proves only that the process can answer HTTP.
- `GET /readyz` returns `503` while draining or when PostgreSQL is unavailable. Load balancers and
  rollout health checks should use this endpoint.
- Set `HYPE_COMMS_METRICS_TOKEN` to an unguessable 32–256 character secret to register `GET /metrics`.
  Scrapers send `Authorization: Bearer <token>`; the endpoint otherwise does not exist. Never place
  this token in repository variables, desktop configuration, query strings, or logs.
- The current Prometheus surface is `hype_comms_http_requests_total`,
  `hype_comms_http_request_duration_seconds_{sum,count}`, `hype_comms_realtime_connections`,
  `hype_comms_postgres_pool_connections`, and `hype_comms_refresh_token_reuse_total`. Route labels use Fastify templates, not raw URLs, so IDs and
  query values cannot create unbounded or sensitive labels.

Initial alerts should cover sustained 5xx responses, readiness failure, nonzero PostgreSQL waiters,
pool utilization near its configured maximum, and unexpected loss of realtime connections. The
broader SLO/alert set in `docs/architecture.md` remains future work until those metrics exist.

## Deploy and rollback evidence

Before promoting a server change:

1. Require `npm run check`, `npm run test:postgres`, and relevant native package lanes.
2. Confirm the new image is addressed by commit SHA and the GitOps commit changes only Hype Comms.
3. Confirm migrations are backward-compatible with the currently deployed server and immediately
   previous desktop version.
4. Watch Argo CD health, `/readyz`, 5xx rate, PostgreSQL pool waiters, and realtime reconnects.
5. Roll back the image through GitOps if application health regresses. Never reverse an applied SQL
   migration; forward-fix it unless the migration was explicitly proven reversible.

Attach the successful Woodpecker pipeline URL to the release record so the installed Woodpecker
version's service, dependency, and concurrency behavior is proven rather than inferred from YAML.

Agent identity rollout requires an expand/enable sequence because the previous server cannot parse
the new persisted user kind. Deploy this migration with `HYPE_COMMS_AGENT_PROVISIONING_ENABLED=false`
(the production default). After the new server is healthy and the previous image has left the
supported rollback window, set the variable to `true` and redeploy before provisioning the first
agent. Do not re-enable rollback to the previous image after an agent has been created.

## Backup and restore gate

The application repository cannot verify cluster backup configuration. Before calling the pilot
durable, record externally verifiable evidence for all of the following:

- automated PostgreSQL backups and their retention;
- encryption and access control for backup material;
- a restore into an isolated database using the same migration history;
- checks of owner sign-in, channel/DM authorization, message/search counts, and `/readyz` after
  restore;
- measured recovery point and recovery time; and
- the person and date responsible for the next restore rehearsal.

A successful backup job without a tested restore is not a completed durability control.

## Desktop release gaps

### Native notification rollout controls

Native notifications are not enabled in ordinary development or ad hoc package builds. The
signed/notarized macOS release build is the first platform-scoped, opt-in pilot: its build includes
the controller, while Windows and Linux release builds explicitly compile presentation off.
`HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED` is read by Electron Vite at build time and accepts only `0`
or `1`; unset and `0` compile the controller off, report native support as unsupported, and never
construct a presenter. Use `HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED=1` only for an explicit
development, headless, native-evidence, or platform-pilot build. It does not turn notifications on
for a device: the versioned main-process preference still defaults disabled, and message-body
preview remains a
separate default-off preference. The variable has no effect when set only at runtime for an
already-built artifact. Release platforms advance independently: enabling the macOS artifact does
not weaken the Windows or Linux evidence gates.

The ordinary interactive demo deliberately removes notification and headless automation variables.
The headless demo instead pins the build flag to `1`, sets `HYPE_COMMS_DESKTOP_HEADLESS=1`, uses isolated
profiles, and supplies `HYPE_COMMS_DESKTOP_HEADLESS_NOTIFICATION_ARTIFACT_DIRECTORY` as a private absolute
per-run directory. It never constructs Electron's native presenter. Eligible outcomes append only
`version`, opaque `captureId`, and `reason` to mode-`0600`
`notifications-<profile>.jsonl` files, capped at 1,024 records. Automation must activate a live
capture through the headless-only strict bridge; editing the artifact cannot create an authorized
action. Do not upload these private run artifacts even though their schema is content-free.

Implementation Milestones 0 through 3 are complete behind those defaults. In a flag-enabled macOS
build, closing the last window leaves only the main notification observer on realtime. It emits no
renderer event, buffers no UI event, and cannot advance the encrypted replica cursor. A recreated
renderer performs replica-first HTTP catch-up, an authoritative snapshot, and final sync before it
opens a fresh realtime epoch. Default-off macOS builds retain last-window realtime stop; Windows
and Linux stop realtime and quit on their last window.

On Windows, main sets Electron Builder's exact
`com.hypemm.hypecomms` AppUserModelID before the first `BrowserWindow`. The source
identity is covered by a deterministic
[test](../apps/desktop/src/main/application-identity.test.ts), but stable attribution and click
handling still require an installed NSIS evidence run. Electron 43 exposes portable native-support
detection but no portable OS permission query. Signed packaged macOS builds therefore load a
universal native addon into Electron's main process to read and request `UNUserNotificationCenter`
authorization from the real Hype Comms process identity before persisting an enable request. Other hosts keep permission
`unknown` where they expose no equivalent. Do not derive `denied` from lack of support or retry a
failed presenter without a new person-initiated enable or capability refresh.

This flag is the rollback boundary for the current slice: rebuild a platform with `0` to remove
presentation while leaving server state, encrypted replicas, unread/mention state, outboxes, and
device preference files untouched. Keep the device default off until that platform's installed
Milestone 4 evidence in [the native-notifications roadmap](native-notifications-roadmap.md) passes.
Ordinary package smoke verifies build contents only. The same workflow also has an opt-in
`native_notification_evidence=true` macOS lane: on an unlocked self-hosted Mac, it builds a
synthetic-only helper with a stable signed identity, requires that helper to own Screen Recording
and Accessibility, signs and notarizes Hype Comms, lets the installed app request its own notification
authorization, verifies an exact native delivery record, captures the OS toast, activates only that
synthetic notification, and captures the restored app. The toast PNG is cropped to the exact
synthetic accessibility element on its containing display, and the click-through PNG contains only
the Hype Comms window; unrelated desktop content is never written to the evidence directory. macOS may prompt the console user; authorize
notifications for **Hype Comms** and grant Screen Recording and Accessibility to **Hype Comms
Evidence**, then rerun the lane after macOS applies them. The capture helper and evidence build are
not release artifacts, and the evidence
directory must never contain real message content. The signed macOS ARM64 lane passed delivery and
click restoration in [run 31757537323](https://github.com/hype-comms/hype-comms/actions/runs/31757537323);
the checked-in [toast](screenshots/macos-native-notification-toast.png) and
[restored-window](screenshots/macos-native-notification-click-through.png) captures contain only the
synthetic evidence state. Each external lane covers every cell of that platform's row in the
[supported host matrix](architecture.md#supported-host-matrix). A platform may enter an opt-in pilot
and complete its gate without waiting for other platforms; the overall roadmap remains open until
every platform passes.

`HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED` itself has no platform dimension: it is one build-time
variable read globally by
[`native-notification-rollout.ts`](../apps/desktop/src/shared/native-notification-rollout.ts) and
`apps/desktop/electron.vite.config.ts`, and every artifact built with it set ships enabled. A
per-platform rollout is therefore a property of *where the variable is set*, not of the variable.
Set it on the individual `package` matrix entry in
[`desktop-release.yml`](../.github/workflows/desktop-release.yml) whose `platform` has passed its
lane—never at workflow, job-wide, repository-variable, or environment level, which would enable it
on the macOS, Windows, and Linux jobs at once and ship unproven platforms enabled in the same
release.

macOS signing/notarization is configured. Windows Authenticode is blocked on procuring a Windows
code-signing certificate and publisher identity; no matching repository secrets or variables exist
today. Once procured, add protected certificate credentials, configure electron-builder with the
publisher subject, and make `Get-AuthenticodeSignature` validate both the installed executable and
NSIS installer before upload. Linux detached signing, SBOM, and provenance are also still open.

Do not describe the current cross-platform feed as fully signed until those independent gates pass.
