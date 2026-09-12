# Protocol 2 production cutover

This runbook implements the operational part of roadmap item 27. Breaking changes are authorized.
Production has not been changed. Complete the remaining installed-update, notification and Hermes
acceptance in [release rehearsal](release-rehearsal.md) before starting the window.

Reserve a 90-minute low-traffic window after the release gates pass. Use the production-size restore
rehearsal to replace that estimate if backup, restore and verification take longer. Record a UTC start,
end, operator and rollback decision time in the release record. At the decision time, allow enough
time for the measured rollback; do not spend that allowance debugging forward deployment. No date
has been scheduled, and this checkout has neither `kubectl` nor a production kubeconfig.

## Deployment ownership

The deployment source is `hypothetical-money-machine/homelab-deploy-kit`. The current target is
cluster `gatorlunch`, namespace `hmm-chat`, Deployment `hmm-chat`, StatefulSet
`hmm-chat-postgres`, and attachment PVC `hmm-chat-data`, mounted at `/data`. Attachments occupy
the `attachments` directory inside that volume, exposed to the app as `/data/attachments`.
PostgreSQL 16 uses its own StatefulSet claim. The public origin is `https://chat-api.hypemm.com`.

Application configuration belongs in `apps/hmm-chat/app.yaml`; the generated workload is under
`clusters/gatorlunch/workloads/hype-comms/`. Run `./manage.sh app-render hmm-chat --in-place` and
`./manage.sh app-check hmm-chat` for structural changes. The renderer preserves the existing image
promotion in `kustomization.yaml`; update both the tag and digest there for the candidate.

ArgoCD's `cluster-workloads` ApplicationSet generates `gatorlunch-workloads` with automatic pruning
and self-healing. A standalone `kubectl scale` can be reversed by reconciliation. Use a reviewed
maintenance commit that sets `images[component=hmm-chat].replicas` to `0`, regenerate the workload,
and sync that revision before taking the backup. Keep the replica count at zero while promoting
the candidate image. Do not disable reconciliation for every workload in the cluster.

Source inspection on 2026-09-12 found the pre-cutover image pin:

```text
registry.fastnfree.dev/homelab/hype-comms:df4b170486c077a17b4c5c672de0057e27aa1672
sha256:b832d407034dad2aa3dff6ca5c3c2743e2dd406cedd3f722083755ca7289d821
```

Re-read the live Deployment image and pod image IDs at the window. This recorded pin is evidence
of the deployment source, not proof of current cluster state. Woodpecker builds and pushes the
server's `linux/amd64` image from `main`; image publication does not promote the workload.

## Release record and prerequisites

Keep a private operational record outside Git with these values and evidence locations:

| Record              | Required value                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Window              | UTC start/end, operator, rollback decision time, measured restore duration                                          |
| Source              | Integrated `main` revision, next unused desktop version, CLI and Hermes revision                                    |
| Candidate           | Immutable server image digest and installer/feed checksums for each supported platform                              |
| Compatible rollback | Separately built protocol-2 server/client revisions and checksums, tested with post-cutover writes                  |
| Previous release    | Live server image ID, deployment commit, previous feed manifests and complete desktop profile backup                |
| Backup              | Private database dump, attachment archive/snapshot, checksums, off-host destination, retention and restore evidence |
| Credentials         | Existing secret/key recovery procedure and reference, without copying plaintext into the release record             |
| Workspaces          | Every workspace ID, pre-cutover sequence, inspected epoch, chosen new epoch and activation output                   |
| Writers             | Maintenance deployment revision, stopped pod/job inventory and database connection check                            |
| Acceptance          | Installed updates, native notifications in their enabled scope, Claude, Hermes, loading and preservation results    |

Integrate the PR stack in dependency order before preparing the stable version through
[the release procedure](../agents/releases.md). Version `0.1.37` already exists; rehearsal packages
using that version must never replace its published artifacts. Build and rehearse the final stable
revision, including a matching CLI and plugin. Prepare packages before stopping service. The normal
tag workflow also publishes the feed, so do not push the tag merely to obtain test packages; use the
manual candidate workflow first and publish the matching release during the coordinated window.

Inventory external polling endpoints without changing those jobs. Stable inbound webhook and
provider callback URLs remain configured. A polling job that depends on a retired first-party
endpoint is an unresolved cutover dependency; it is not fixed by leaving a scheduler running.
Stop product agents, Hermes delivery, standalone senders and any maintenance writers for the window.
Retain their tokens, profiles and cursor files. Old desktop composer drafts live in memory: users
must save them outside the app or queue them before quitting. Do not delete profiles, keys or
databases containing unsent work.

## Rehearse the procedure

The repository includes a disposable server rehearsal:

```sh
npm run rehearse:server-cutover -- \
  --candidate-image LOCAL_CANDIDATE_IMAGE \
  --rollback-image LOCAL_PROTOCOL_2_ROLLBACK_IMAGE
```

Build both images first with the root Dockerfile and make `postgres:16-alpine` available locally.
The script resolves immutable local image IDs and requires two distinct builds. It creates its own
network, PostgreSQL container and two attachment volumes. It exposes only loopback server ports.
It never accepts a production database URL or an existing volume. It removes only the resources it
created, and reports its resource prefix if cleanup fails. Evidence has a unique filename under
`.dev-data/rehearsal/server-cutover/`; no credentials or message data are written there.

The rehearsal seeds a human session, agent credential, attachment, message and task. With its writer
stopped, it dumps and restores PostgreSQL, compares every public table, archives and restores the
attachment volume, invokes the real migrator and repeats the same epoch activation. It then retries
the accepted message, rejects the old cursor, downloads the restored attachment and accepts a new
reply. It starts the rollback image against that same database and verifies the reply, original
receipt, session, agent credential and attachment, then exercises two WebSocket connections. It
does not restore a database over the post-cutover reply.

This synthetic check complements the old-schema integration tests. Production-size restore,
Kubernetes access and reconciliation, AuthKit callbacks, installed desktop updates and the actual
Hermes framework still need their own evidence. Run the real maintenance backup procedure against
an isolated restore target before scheduling downtime. The deploy kit's database-VM backup helpers
use `sudo -u postgres`; they do not address this Kubernetes StatefulSet. Its dump-format check and
scratch-table check are not a restoration of this application's dump.

## Stop writers and capture the backup

Run the commands on the designated deployment host. Set `cutover_context` to its verified
`gatorlunch` context and `cutover_dir` to a new private directory in the approved backup location.
Use `umask 077`. Keep shell tracing off. Never paste backup contents, secret manifests or invitation
URLs into a PR, chat or workflow log.

1. Sync the reviewed maintenance revision. Confirm the Deployment's desired and observed replicas
   are zero, every old app pod has terminated, no Job/CronJob or separate realtime process is a writer,
   and no public request can reach a product pod. Keep PostgreSQL running. Record existing external
   polling jobs as unchanged; product senders must remain stopped.
2. Inspect PostgreSQL connections. Record PID, application name and state, without query text or
   credentials. Resolve any unexplained client connection before proceeding. With writers stopped,
   read every workspace ID and `last_event_sequence`, and save them alongside the backup. Later epoch
   inspection must match these sequences.
3. Create the database dump directly from the PostgreSQL container. Resolve its current pod name
   first; the expected name is `hmm-chat-postgres-0`.

```sh
kubectl --context "$cutover_context" -n hmm-chat exec hmm-chat-postgres-0 -- \
  sh -ec 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' \
  > "$cutover_dir/database.dump"
```

Mount `hmm-chat-data` read-only in a temporary operator pod on the workload cluster. Keep its labels
different from the `hmm-chat` Service selector. Use the candidate image by digest, `restartPolicy:
Never`, and a sleeping Node process instead of `dist/main.js`; this pod must not start the server.
Its environment needs the existing database secret reference, public API URL and manual email
configuration for the operator CLI. Its volume mounts `/data` read-only. Do not copy secret values
into the manifest. Wait for any ReadWriteOnce attachment to be released before mounting it.

```sh
kubectl --context "$cutover_context" -n hmm-chat exec hmm-chat-maintenance -- \
  tar -C /data -czf - attachments > "$cutover_dir/attachments.tar.gz"
sha256sum "$cutover_dir/database.dump" "$cutover_dir/attachments.tar.gz" \
  > "$cutover_dir/SHA256SUMS"
```

Use the approved encrypted off-host backup destination and verify the copied checksums. Preserve
existing AuthKit encryption keys and credential secrets through their normal recovery mechanism.
An attachment archive and database dump from different write periods are not a matching backup.

Restore the dump into a new isolated PostgreSQL 16 database with `pg_restore --exit-on-error
--no-owner --no-privileges`; extract attachments into a new volume with their ownership and modes.
Do not use `--clean` against the production database. Compare per-table row counts and canonical
row digests, credentials and idempotency records, and attachment digests. Exercise an authenticated
download through the restored server. Record elapsed time and the complete restore result before
applying a production migration.

## Migrate and establish the epoch

The maintenance pod must use the candidate digest and the same database secret reference as the
Deployment. Run the packaged migrator with the product Deployment still at zero:

```sh
kubectl --context "$cutover_context" -n hmm-chat exec hmm-chat-maintenance -- \
  node dist/db/migrate.js
kubectl --context "$cutover_context" -n hmm-chat exec hmm-chat-maintenance -- \
  node dist/modules/workspace/protocol-epoch-cli.js inspect --workspace-id "$workspace_id"
```

Repeat inspection for every workspace. Compare the sequence with the stopped-writer record, save
the returned epoch and sequence, and generate one new UUID for each workspace. Record all arguments
before activation. Use `none` only if inspection returned a null epoch.

```sh
kubectl --context "$cutover_context" -n hmm-chat exec hmm-chat-maintenance -- \
  node dist/modules/workspace/protocol-epoch-cli.js activate \
  --workspace-id "$workspace_id" --expected-epoch "$previous_epoch" \
  --expected-sequence "$previous_sequence" --epoch "$new_epoch" --writers-stopped
```

Save activation output with the release record. If the command is interrupted, retry the same
arguments and the same new UUID. A changed expected sequence is a failed stopped-writer check,
not an invitation to advance the expected value. No historical event, migration file, idempotency
key or local outbox identity is rewritten as part of this operation.

## Verify privately, then reopen

Promote the candidate tag and digest in the deployment repository while retaining zero replicas.
For private smoke testing, create one standalone candidate pod from the full deployed pod spec,
including its existing environment references, volume and security settings. Give it unique labels
that do not match the public Service. Remove the sleeping maintenance pod first if the volume cannot
be mounted twice. Reach the candidate through a loopback `kubectl port-forward` or the approved
private access path. The public Deployment remains stopped throughout this check.

Run login through both supported login paths, send/reply, upload/download, task mutation and realtime
reconnect. Check one general agent and the matching Hermes plugin/CLI; run the active Claude smoke.
Open the installed candidate against the controlled target and verify retained outbox delivery using
its original IDs, including a previously accepted send whose acknowledgement was lost. Check that
an unrelated task-loading failure leaves chat usable. Save renderer and keyboard evidence.

Old workspace clients must receive HTTP 426 with the old-parseable `CONFLICT` error envelope;
protocol-2 clients must stop automatic retries on protocol mismatch. A wrong-epoch cursor must
require bootstrap. Existing callback and inbound webhook paths must retain their configuration.
Verify private smoke messages and their receipts before opening the public route.

Publish the matching unused desktop version and CLI/plugin artifacts while public service remains
closed. Verify all supported platform feed manifests and signatures under their existing policies.
Delete the private candidate pod, restore the Deployment replica count through a reviewed
deployment-source commit, regenerate/check the manifests, and sync. Verify the running image ID,
readiness, login and one send/reply/reconnect cycle, then resume the product agents and Hermes.
Record the exact time writes reopened and the new workspace positions. Keep external polling
configuration unchanged.

## Rollback and later cleanup

Before public writes reopen, the operator may restore the coordinated pre-cutover database,
attachments, deployment and client distribution state. Stop the private candidate before restoring.
Track any private smoke mutations that will be discarded. A client whose local replica already
migrated may not reopen in the old desktop build, so the installed rollback rehearsal and preserved
profile/outbox determine the client recovery procedure. Never delete its migrated profile merely
to make the old build start.

After writes reopen, use the tested protocol-2-compatible rollback build against the current
database and attachment volume, or roll forward. Keep the active epoch and replay floor. Do not
restore a pre-cutover database over new messages. Do not publish an older desktop version over a
new one; use the tested compatible distribution plan or a newer forward fix. Withdrawing a feed
alone does not downgrade clients that have already installed an update.

After one complete successful production release cycle, inventory active reads of the old capability
columns and temporary response normalization. Only then prepare a separate additive/cleanup review
and migration removing unused columns and transitional code. Confirm retained receipts and unsent
work no longer need a transitional reader before removing it. Keep historical migrations and the
predictable unsupported-major response. No cleanup migration is part of this preparatory PR.
