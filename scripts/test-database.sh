#!/usr/bin/env bash
#
# Runs the server tests against a disposable PostgreSQL container.
#
# Usage: scripts/test-database.sh [vitest arguments]

set -euo pipefail

POSTGRES_IMAGE="${HMM_TEST_POSTGRES_IMAGE:-postgres:16-alpine}"
POSTGRES_USER="hmm"
POSTGRES_PASSWORD="hmm-test-password"
POSTGRES_DATABASE="hmm_chat_test"
CONTAINER_NAME="hmm-chat-test-postgres-$$-${RANDOM}"

# The signal traps pass an explicit status because bash reports $? as 0 on the SIGINT path, so a
# cleanup that re-reads it would let an aborted run look like a pass to anything chaining off
# this script. Removal is unconditional rather than gated on a captured container id: an
# interrupt can kill the docker CLI after the daemon created the container but before its id
# reached stdout, and the name embeds $$ and $RANDOM so nothing could ever reap it afterwards.
completed=0
signal_status=0

# macOS ships bash 3.2, where an interrupt arriving while a child process is running does not
# reliably run the INT trap: only the EXIT trap runs, and it observes $? as 0. Success is
# therefore asserted explicitly at the end of the script rather than inferred from the exit
# status, so an aborted run can never report success to `npm run test:db && ...`.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm --force --volumes "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ "$signal_status" != "0" ]]; then
    status="$signal_status"
  elif [[ "$completed" != "1" && "$status" == "0" ]]; then
    status=130
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'signal_status=130; exit 130' INT
trap 'signal_status=143; exit 143' TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH; install Docker to run npm run test:db." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running; start Docker and try npm run test:db again." >&2
  exit 1
fi

echo "==> starting disposable PostgreSQL ($POSTGRES_IMAGE)"
docker run --detach >/dev/null \
    --name "$CONTAINER_NAME" \
    --publish "127.0.0.1::5432" \
    --env "POSTGRES_USER=$POSTGRES_USER" \
    --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
    --env "POSTGRES_DB=$POSTGRES_DATABASE" \
    --env "POSTGRES_INITDB_ARGS=--locale-provider=icu --icu-locale=und-x-icu" \
    --security-opt no-new-privileges:true \
    "$POSTGRES_IMAGE"

HOST_PORT="$(
  docker inspect \
    --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' \
    "$CONTAINER_NAME"
)"

# Probe TCP, not the unix socket. The postgres entrypoint runs a temporary init server with
# listen_addresses='' that answers on the socket a few hundred milliseconds before the real
# server binds 5432, so a socket probe reports ready while connections still fail. That window
# is wider than this loop's cadence on a loaded machine, which made it an intermittent failure
# rather than an obvious one.
database_ready=false
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER_NAME" \
    pg_isready --quiet --host 127.0.0.1 --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DATABASE" 2>/dev/null; then
    database_ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" != "true" ]]; then
    break
  fi
  sleep 0.25
done

if [[ "$database_ready" != "true" ]]; then
  echo "Disposable PostgreSQL did not become ready." >&2
  docker logs "$CONTAINER_NAME" 2>&1 | tail -20 >&2 || true
  exit 1
fi

echo "==> running the guarded PostgreSQL suite on Docker-assigned port $HOST_PORT"
HMM_TEST_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${HOST_PORT}/${POSTGRES_DATABASE}" \
  npm run test:postgres -- "$@"

# Reached only when the suite ran to completion; `set -e` exits earlier on failure.
completed=1
