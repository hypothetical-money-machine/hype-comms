# Pilot operations

This document covers the automation and checks in this repository. Kubernetes manifests, ingress,
database backup scheduling, secret injection, and production rollback evidence are maintained in
the deployment repository and must be verified there.

## Delivery

GitHub Actions runs `npm run check` and desktop package smoke on pull requests and pushes to
`main`. The smoke builds use the DEV identity on each platform and also check the production
identity on Linux.

A push to `main` runs `.woodpecker.yml`. It runs source and PostgreSQL checks, builds a
commit-addressed server image, and promotes that image through the deployment repository. Workflow
concurrency prevents an older `main` build from promoting after a newer one.

A desktop release starts with a `v<version>` tag on `main` that matches
`apps/desktop/package.json`. The release job requires reviewed
`docs/releases/v<version>.md`, packages production artifacts, verifies them, publishes the update
feed, and creates the GitHub Release. Follow [the release runbook](agents/releases.md).

## Health and metrics

- `GET /livez` checks that the process can answer HTTP.
- `GET /readyz` returns `503` while the service is draining or PostgreSQL is unavailable. Use it
  for load-balancer and rollout health checks.
- Set `HYPE_COMMS_METRICS_TOKEN` to a 32- to 256-character secret to enable `GET /metrics`.
  Scrapers send `Authorization: Bearer <token>`. Do not put this token in desktop configuration,
  query strings, or logs.
- The endpoint reports HTTP request totals and duration, authenticated realtime connections,
  PostgreSQL pool state, and refresh-token reuse. Route labels use Fastify templates, so IDs and
  query values do not become metric labels.

Watch sustained 5xx responses, readiness failures, PostgreSQL waiters, high pool use, and sudden
realtime-connection loss during a rollout.

## Deploy and rollback

Before promoting a server change, run `npm run check`, `npm run test:postgres`, and the relevant
desktop package checks. Confirm the image is addressed by commit SHA, the GitOps change only
updates Hype Comms, and migrations are compatible with the running service and previous desktop
version. Watch Argo CD health, `/readyz`, 5xx responses, PostgreSQL pool waiters, and realtime
reconnects.

Roll back the application image through GitOps when application health regresses. Do not reverse an
applied SQL migration. Use a forward fix unless the migration has a documented reversible path.
Attach the successful Woodpecker pipeline URL to the release record.

Agent identities require an expand-and-enable deployment. Deploy their migration with
`HYPE_COMMS_AGENT_PROVISIONING_ENABLED=false`. Enable it only after the previous server image is
outside the rollback window. Do not roll back to an image that cannot read persisted agent
identities.

## Backup and restore

Before treating the deployment as durable, keep externally verifiable evidence of automated
PostgreSQL backups, encryption and access control, a restore into an isolated database, and checks
of owner sign-in, channel and DM authorization, message and search counts, and `/readyz` after the
restore. Record the measured recovery point and recovery time and the next restore rehearsal.

## Package identities

An unset `HYPE_COMMS_BUILD_FLAVOR` creates the side-by-side `Hype Comms DEV` package. It has its
own application ID, executable, Linux package, profile, sign-in protocol, and package output. It
does not use the stable update feed.

Production builds use the stable application ID, `hype-comms://` sign-in protocol, profile, and
update feed. Only `development` and `production` are valid build flavors. Release and installed
evidence jobs set `production` explicitly.

## Native notifications

Ordinary development and package builds compile notification presentation out. The macOS release
job can build the opt-in controller. Windows and Linux release builds currently compile it out.
The device preference and message preview default to disabled in an enabled build.

Headless demo builds use a capture presenter and private artifacts. They never construct Electron's
native presenter. Read [native-notifications-roadmap.md](native-notifications-roadmap.md) before
enabling the feature in a release job.

## Signatures

macOS release builds are signed and notarized. Windows releases publish unsigned installers until
all Azure Trusted Signing values are configured; a partial configuration or signing failure blocks
publication. Linux packages have updater checksums but no detached-signature, SBOM, or provenance
gate. See [windows-signing.md](windows-signing.md).
