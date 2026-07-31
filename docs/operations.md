# Pilot operations

This is the operational contract for the deployment that exists today. The AWS/Cloudflare design
in `docs/architecture.md` is a hosted target, not the current topology.

## Delivery ownership

- GitHub pull requests run native desktop package smoke. The `CI` workflow also runs the complete
  source gate and all PostgreSQL integration tests on an isolated job-scoped PostgreSQL 16 cluster.
- A push to `main` runs `.woodpecker.yml`: source checks, an immutable-SHA server image build into
  `registry.example.invalid/example-project/hmm-chat`, then a GitOps image promotion in
  `hype-comms/deployment-repository` for the `production-cluster` cluster.
- A `v*` tag on `main` must exactly match `apps/desktop/package.json`. Native release jobs package
  and publish platform artifacts and the platform manifest to the S3-compatible storage update bucket.
- Kubernetes manifests, ingress/TLS, database lifecycle, secret injection, Argo CD health, backup
  scheduling, and production rollback are owned by `deployment-repository`. A release review must link
  evidence from that repository rather than assuming these controls from application code.

## Service checks and metrics

- `GET /livez` proves only that the process can answer HTTP.
- `GET /readyz` returns `503` while draining or when PostgreSQL is unavailable. Load balancers and
  rollout health checks should use this endpoint.
- Set `HMM_METRICS_TOKEN` to an unguessable 32–256 character secret to register `GET /metrics`.
  Scrapers send `Authorization: Bearer <token>`; the endpoint otherwise does not exist. Never place
  this token in repository variables, desktop configuration, query strings, or logs.
- The current Prometheus surface is `hmm_chat_http_requests_total`,
  `hmm_chat_http_request_duration_seconds_{sum,count}`, `hmm_chat_realtime_connections`, and
  `hmm_chat_postgres_pool_connections`. Route labels use Fastify templates, not raw URLs, so IDs and
  query values cannot create unbounded or sensitive labels.

Initial alerts should cover sustained 5xx responses, readiness failure, nonzero PostgreSQL waiters,
pool utilization near its configured maximum, and unexpected loss of realtime connections. The
broader SLO/alert set in `docs/architecture.md` remains future work until those metrics exist.

## Deploy and rollback evidence

Before promoting a server change:

1. Require `npm run check`, the complete PostgreSQL check, and relevant native package lanes.
2. Confirm the new image is addressed by commit SHA and the GitOps commit changes only Hype Comms.
3. Confirm migrations are backward-compatible with the currently deployed server and immediately
   previous desktop version.
4. Watch Argo CD health, `/readyz`, 5xx rate, PostgreSQL pool waiters, and realtime reconnects.
5. Roll back the image through GitOps if application health regresses. Never reverse an applied SQL
   migration; forward-fix it unless the migration was explicitly proven reversible.

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

macOS signing/notarization is configured. Windows Authenticode is blocked on procuring a Windows
code-signing certificate and publisher identity; no matching repository secrets or variables exist
today. Once procured, add protected certificate credentials, configure electron-builder with the
publisher subject, and make `Get-AuthenticodeSignature` validate both the installed executable and
NSIS installer before upload. Linux detached signing, SBOM, and provenance are also still open.

Do not describe the current cross-platform feed as fully signed until those independent gates pass.
