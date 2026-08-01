# Local Linux release runner

The ARM64 runner replaces the GitHub-hosted Linux release lane with an isolated Ubuntu
container running natively on the Apple-silicon Mac Mini. The legacy x64 service remains
available for ad hoc release-environment compatibility checks; pull-request smoke packaging
runs on the separate always-on x64 CI runner. Each service uses the matching official GitHub
Actions runner and AWS CLI binaries, stores only runner state in its own named Docker volume,
and does not mount the host filesystem or Docker socket.

Build and register the ARM64 runner once:

```bash
docker compose -f docker-compose.runner.yml build linux-arm64
runner_token="$(
  gh api -X POST \
    repos/hype-comms/hmm-chat/actions/runners/registration-token \
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

Check the local container and GitHub registration:

```bash
docker compose -f docker-compose.runner.yml ps linux-arm64
gh api repos/hype-comms/hmm-chat/actions/runners \
  --jq '.runners[] | select(.name == "hmm-chat-docker-linux-arm64")'
```

The registration survives container and Docker Desktop restarts in the
`hmm-chat-runner-data-arm64` volume. To remove it, first remove the runner in the
repository's Actions settings, then run:

```bash
docker compose -f docker-compose.runner.yml rm --stop --force linux-arm64
docker volume rm hmm-chat-runner-data-arm64
```
