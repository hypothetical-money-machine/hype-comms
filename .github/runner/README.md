# Local Linux release runner

This runner replaces the GitHub-hosted Linux release lane with an isolated x64 Ubuntu
container. It uses the official GitHub Actions runner binary, stores only runner state in a
named Docker volume, and does not mount the host filesystem or Docker socket.

Build and register it once:

```bash
docker compose -f docker-compose.runner.yml build
runner_token="$(
  gh api -X POST \
    repos/hype-comms/hmm-chat/actions/runners/registration-token \
    --jq .token
)"
RUNNER_TOKEN="$runner_token" docker compose -f docker-compose.runner.yml run \
  --rm \
  --env RUNNER_TOKEN \
  --env RUNNER_CONFIGURE_ONLY=true \
  linux-x64
unset runner_token
docker compose -f docker-compose.runner.yml up --detach
```

Check the local container and GitHub registration:

```bash
docker compose -f docker-compose.runner.yml ps
gh api repos/hype-comms/hmm-chat/actions/runners \
  --jq '.runners[] | select(.name == "hmm-chat-docker-linux-x64")'
```

The registration survives container and Docker Desktop restarts in the
`hmm-chat-runner-data` volume. To remove it, first remove the runner in the repository's
Actions settings, then run:

```bash
docker compose -f docker-compose.runner.yml down
docker volume rm hmm-chat-runner-data
```
