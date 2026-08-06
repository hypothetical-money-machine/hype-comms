# Task bots

Hype Comms bots are first-class workspace members with task-only service credentials. An owner
creates them from the server CLI, chooses their scopes, and explicitly grants every channel they
may see. A bot does **not** inherit access to `workspace` (Everyone) channels, cannot open DMs, and
cannot call chat, search, bootstrap, sync, realtime, member-directory, or session endpoints.

Bots count toward the 25-active-member pilot limit. Their public user record has `kind: "bot"` and
no email address. Credential tokens contain 256 random bits, are printed once, and are stored only
as SHA-256 hashes. The server redacts the `Authorization` header from request logs.

## Create and inspect a bot

The server command uses `HMM_DATABASE_URL` and the first active workspace owner. Channel flags are
explicit and repeatable. Omitting `--scope` grants both current task scopes; credentials expire in
90 days by default.

```bash
npm run bot --workspace @hmm-chat/server -- create \
  --username release-bot \
  --display-name "Release Bot" \
  --channel general \
  --scope tasks:read \
  --scope tasks:write \
  --expires-in-days 90
```

The token is shown once. Put it in the bot runner's secret store; do not send it through the
renderer, commit it, or place it in a URL. List bots and their non-secret access state with:

```bash
npm run bot --workspace @hmm-chat/server -- list
```

Add another channel grant without minting a credential:

```bash
npm run bot --workspace @hmm-chat/server -- grant \
  --username release-bot \
  --channel launch-planning
```

Rotation atomically revokes every prior credential for that bot and prints one replacement. Scope
and expiry flags have the same defaults as `create`.

```bash
npm run bot --workspace @hmm-chat/server -- rotate \
  --username release-bot \
  --scope tasks:read \
  --scope tasks:write
```

Revoke all active credentials immediately without deleting the bot, its grants, assignments, or
audit attribution:

```bash
npm run bot --workspace @hmm-chat/server -- revoke --username release-bot
```

## Call task routes

Send the credential only in an HTTPS `Authorization` header. The examples assume the token and API
origin were loaded from a secret store into the process environment.

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${HMM_BOT_TOKEN}" \
  "${HMM_API_ORIGIN}/v1/conversations/${CHANNEL_ID}/tasks?limit=100"
```

Create operations require a stable `Idempotency-Key`. A bot should derive this from the external
event or job that caused the task instead of generating a new value on every retry.

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${HMM_BOT_TOKEN}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: deploy:production:2026-08-05.1" \
  --data '{"title":"Verify production rollout","priority":"high"}' \
  "${HMM_API_ORIGIN}/v1/conversations/${CHANNEL_ID}/tasks"
```

The same credential may use `GET /v1/tasks/mine` for tasks assigned to its bot identity. Updates
and Kanban moves use the existing optimistic `expectedVersion` contract and their own stable
idempotency keys. A stale version returns `409 CONFLICT`; read the board again before deciding
whether to retry the intended change.

`tasks:read` permits the two task-list routes. `tasks:write` permits create, update, and move routes.
Write responses include the canonical task that was changed, but the scope does not permit list
access. Supplying any bearer credential opts into bot authentication: an invalid or expired token
never falls back to a human session cookie.
