#!/usr/bin/env bash
#
# End-to-end smoke test for the packaged server image.
#
# Starts the container with a throwaway access code, then exercises health, sign-in, message
# creation with a server-derived author, history persistence across a restart, and rejection of
# unauthenticated and throttled requests.
#
# Usage: scripts/smoke-container.sh [image]

set -euo pipefail

IMAGE="${1:-hmm-chat-server:smoke}"
CONTAINER="hmm-chat-smoke-$$"
VOLUME="hmm-chat-smoke-data-$$"
ACCESS_CODE="smoke-test-access-code"
PORT=38080
BASE="http://127.0.0.1:${PORT}"
COOKIES="$(mktemp)"

cleanup() {
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$COOKIES"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2 || true
  exit 1
}

start_container() {
  docker run --detach --name "$CONTAINER" \
    --publish "127.0.0.1:${PORT}:3000" \
    --volume "${VOLUME}:/data" \
    --read-only --tmpfs /tmp --cap-drop ALL \
    --env NODE_ENV=production \
    --env HMM_HOST=0.0.0.0 \
    --env HMM_PUBLIC_API_URL=https://chat-api.example.invalid \
    --env HMM_ALLOWED_ORIGINS=app://bundle \
    --env HMM_CHAT_ENABLED=true \
    --env HMM_CHAT_ACCESS_CODE="$ACCESS_CODE" \
    "$IMAGE" >/dev/null
}

wait_for_health() {
  for _ in $(seq 1 40); do
    if curl --silent --fail "${BASE}/livez" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  fail "server did not become healthy"
}

status_of() {
  curl --silent --output /dev/null --write-out '%{http_code}' "$@"
}

echo "==> starting container"
start_container
wait_for_health
echo "    healthy"

echo "==> rejects unauthenticated history"
[ "$(status_of "${BASE}/v1/chat/welcome/messages")" = "401" ] \
  || fail "expected 401 for unauthenticated history"

echo "==> rejects a wrong access code"
[ "$(status_of --request POST "${BASE}/v1/chat/session" \
  --header 'content-type: application/json' \
  --data '{"name":"Morgan","accessCode":"wrong-access-code"}')" = "401" ] \
  || fail "expected 401 for a wrong access code"

echo "==> rejects a malformed JSON body with 400"
[ "$(status_of --request POST "${BASE}/v1/chat/session" \
  --header 'content-type: application/json' \
  --data 'not json')" = "400" ] \
  || fail "expected 400 for a malformed body"

echo "==> signs in with the correct access code"
SIGNIN_PAYLOAD=$(printf '{"name":"Morgan","accessCode":"%s"}' "$ACCESS_CODE")
SIGNIN_CODE="$(status_of --request POST "${BASE}/v1/chat/session" \
  --cookie-jar "$COOKIES" \
  --header 'content-type: application/json' \
  --data "$SIGNIN_PAYLOAD")"
[ "$SIGNIN_CODE" = "204" ] || fail "expected 204 for a valid sign-in, got $SIGNIN_CODE"
grep -q hmm_chat_session "$COOKIES" || fail "session cookie was not issued"

echo "==> posts a message with a server-derived author"
CREATED="$(curl --silent --request POST "${BASE}/v1/chat/welcome/messages" \
  --cookie "$COOKIES" \
  --header 'content-type: application/json' \
  --data '{"clientMessageId":"10000000-0000-4000-8000-0000000000aa","body":"Container smoke"}')"
echo "$CREATED" | grep -q '"authorName":"Morgan"' || fail "author was not derived from the session: $CREATED"

echo "==> ignores a client-supplied author"
SPOOFED="$(curl --silent --request POST "${BASE}/v1/chat/welcome/messages" \
  --cookie "$COOKIES" \
  --header 'content-type: application/json' \
  --data '{"clientMessageId":"10000000-0000-4000-8000-0000000000ab","body":"Spoof","authorName":"Alex"}')"
echo "$SPOOFED" | grep -q '"code":"BAD_REQUEST"' || fail "expected strict schema to reject an extra field: $SPOOFED"

echo "==> persists history across a restart"
docker restart "$CONTAINER" >/dev/null
wait_for_health
HISTORY="$(curl --silent --cookie "$COOKIES" "${BASE}/v1/chat/welcome/messages")"
echo "$HISTORY" | grep -q "Container smoke" || fail "history did not survive a restart: $HISTORY"

echo "==> keeps the session valid across a restart"
[ "$(status_of --cookie "$COOKIES" "${BASE}/v1/chat/session")" = "200" ] \
  || fail "session did not survive a restart"

echo "==> throttles repeated failures"
THROTTLED=false
for _ in $(seq 1 12); do
  CODE="$(status_of --request POST "${BASE}/v1/chat/session" \
    --header 'content-type: application/json' \
    --data '{"name":"Morgan","accessCode":"wrong-access-code"}')"
  if [ "$CODE" = "429" ]; then
    THROTTLED=true
    break
  fi
done
[ "$THROTTLED" = true ] || fail "sign-in was never throttled"

echo "==> confirms the removed unauthenticated routes stay gone"
[ "$(status_of "${BASE}/v1/development/welcome/messages")" = "404" ] \
  || fail "the unauthenticated development routes are reachable"

echo
echo "PASS: container smoke test"
