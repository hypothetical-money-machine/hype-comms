# Local Linux release runner

The ARM64 runner replaces the GitHub-hosted Linux release lane and runs the required PostgreSQL
CI job in an isolated Ubuntu container, natively on an Apple-silicon host. PostgreSQL 16 is
baked into the image so CI can create an unprivileged, job-scoped database cluster without a
Docker socket or passwordless sudo. Linux release packaging and pull-request smoke packaging both
run on this native ARM64 service. The legacy x64 service remains available for ad hoc
release-environment compatibility checks. Each service uses the matching official GitHub Actions
runner and AWS CLI binaries, stores only runner state in its own named Docker volume, and does not
mount the host filesystem or Docker socket.

Build and register the ARM64 runner once:

```bash
docker compose -f docker-compose.runner.yml build linux-arm64
runner_token="$(
  gh api -X POST \
    repos/hype-comms/hype-comms/actions/runners/registration-token \
    --jq .token
)"
RUNNER_TOKEN="$runner_token" docker compose -f docker-compose.runner.yml run \
  --rm \
  --env RUNNER_TOKEN \
  --env RUNNER_CONFIGURE_ONLY=true \
  linux-arm64
unset runner_token
docker compose -f docker-compose.runner.yml up --detach linux-arm64
```

After a runner image change, rebuild and recreate the service. The existing GitHub registration
survives in its named volume:

```bash
docker compose -f docker-compose.runner.yml up --detach --build --force-recreate linux-arm64
docker compose -f docker-compose.runner.yml exec linux-arm64 \
  /usr/lib/postgresql/16/bin/postgres --version
```

Check the local container and GitHub registration:

```bash
docker compose -f docker-compose.runner.yml ps linux-arm64
gh api repos/hype-comms/hype-comms/actions/runners \
  --jq '.runners[] | select(.name == "hype-comms-docker-linux-arm64")'
```

The registration survives container and Docker Desktop restarts in the
`hype-comms-runner-data-arm64` volume. To remove it, first remove the runner in the
repository's Actions settings, then run:

```bash
docker compose -f docker-compose.runner.yml rm --stop --force linux-arm64
docker volume rm hype-comms-runner-data-arm64
```

## Multiple x64 CI hosts

The x64 service can also register against an organization runner group. Give every physical host
a unique runner name, while using the same group and capability labels to form a shared pool. The
group must already exist and allow this repository before registration.

Set these non-secret values on each host before building, registering, or starting the service:

The examples in this section use Bash; start `bash` first when the host's login shell is fish.

```bash
export HYPE_COMMS_X64_RUNNER_URL=https://github.com/hype-comms
export HYPE_COMMS_X64_RUNNER_GROUP=hmm-linux-x64-ci
export HYPE_COMMS_X64_RUNNER_LABELS=hmm-ci
export HYPE_COMMS_X64_RUNNER_NAME=self-hosted-ci-runner # use a unique name per physical host
```

Build and register the service using a short-lived organization registration token:

```bash
docker compose -f docker-compose.runner.yml build linux-x64
RUNNER_TOKEN="$runner_token" docker compose -f docker-compose.runner.yml run \
  --rm \
  --env RUNNER_TOKEN \
  --env RUNNER_CONFIGURE_ONLY=true \
  linux-x64
unset runner_token
docker compose -f docker-compose.runner.yml up --detach linux-x64
```

Generate `runner_token` from an authenticated operator session immediately before registration;
do not save it in the repository, an environment file, shell history, or the host's persistent
runner volume. The GitHub Actions runner adds the standard `self-hosted`, `Linux`, and `X64` labels
alongside `hmm-ci`. Jobs in this pool do not receive the `hype-comms-release` or `docker` labels.
