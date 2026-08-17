#!/usr/bin/env bash

set -euo pipefail

cd /runner

if [[ ! -f .runner ]]; then
  : "${RUNNER_URL:?RUNNER_URL is required}"
  : "${RUNNER_TOKEN:?RUNNER_TOKEN is required for initial registration}"

  config_args=(
    --unattended
    --replace
    --url "$RUNNER_URL"
    --token "$RUNNER_TOKEN"
    --name "${RUNNER_NAME:-hype-comms-docker-linux-x64}"
    --labels "${RUNNER_LABELS:-hype-comms-release,docker}"
    --work _work
  )
  if [[ -n "${RUNNER_GROUP:-}" ]]; then
    config_args+=(--runnergroup "$RUNNER_GROUP")
  fi

  ./config.sh "${config_args[@]}"
fi

if [[ "${RUNNER_CONFIGURE_ONLY:-false}" == "true" ]]; then
  exit 0
fi

exec ./run.sh
