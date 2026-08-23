# Task bots

Hype Comms bots are first-class workspace members with task-only service credentials. An owner
creates them from the server CLI, chooses their scopes, and grants every channel they may see.
Bots do not inherit access to `workspace` (Everyone) channels, cannot open DMs, and cannot call
chat, search, bootstrap, sync, realtime, member-directory, or session endpoints.

Bots count toward the 25-active-member pilot limit. Their public user record has `kind: "bot"` and
no email address. Credential tokens contain 256 random bits, are printed once, and are stored only
as SHA-256 hashes. The server redacts the `Authorization` header from request logs.

## Create and inspect a bot

The server command uses `HYPE_COMMS_DATABASE_URL` and the first active workspace owner. Channel flags are
explicit and repeatable. Omitting `--scope` grants both current task scopes; credentials expire in
90 days by default.

```bash
npm run bot --workspace @hype-comms/server -- create \
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
npm run bot --workspace @hype-comms/server -- list
```

Add another channel grant without minting a credential:

```bash
npm run bot --workspace @hype-comms/server -- grant \
  --username release-bot \
  --channel launch-planning
```

Rotation atomically revokes every prior credential for that bot and prints one replacement. Scope
and expiry flags have the same defaults as `create`.

```bash
npm run bot --workspace @hype-comms/server -- rotate \
  --username release-bot \
  --scope tasks:read \
  --scope tasks:write
```

Revoke all active credentials immediately without deleting the bot, its grants, assignments, or
audit attribution:

```bash
npm run bot --workspace @hype-comms/server -- revoke --username release-bot
```

## Call task routes

Send the credential only in an HTTPS `Authorization` header. The examples assume the token and API
origin were loaded from a secret store into the process environment.

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${HYPE_COMMS_BOT_TOKEN}" \
  "${HYPE_COMMS_API_ORIGIN}/v1/channels/${CHANNEL_SLUG}/tasks?limit=100"
```

Create operations require a stable `Idempotency-Key`. Derive it from the external event or job
that created the task and reuse it on every retry.

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${HYPE_COMMS_BOT_TOKEN}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: deploy:production:2026-08-05.1" \
  --data '{"title":"Verify production rollout","priority":"high"}' \
  "${HYPE_COMMS_API_ORIGIN}/v1/channels/${CHANNEL_SLUG}/tasks"
```

Channel slugs and conversation-local task numbers form stable human-readable references. Fetch
`#general-42` without scanning the board, or use the canonical task UUID returned by any response:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${HYPE_COMMS_BOT_TOKEN}" \
  "${HYPE_COMMS_API_ORIGIN}/v1/channels/general/tasks/42"

curl --fail-with-body \
  --header "Authorization: Bearer ${HYPE_COMMS_BOT_TOKEN}" \
  "${HYPE_COMMS_API_ORIGIN}/v1/tasks/${TASK_ID}"
```

Board and My Tasks lists accept optional `status`, `priority`, `assignee`, `dueAfter`, `dueBefore`,
`updatedAfter`, and `updatedBy` filters. `assignee` accepts a user UUID, `me`, or `unassigned`;
`updatedBy` accepts a user UUID or `me`. Due-date bounds are inclusive and `updatedAfter` is
exclusive. For example, a bot can poll its recently changed urgent work without downloading every
card:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${HYPE_COMMS_BOT_TOKEN}" \
  "${HYPE_COMMS_API_ORIGIN}/v1/channels/general/tasks?status=in_progress&priority=urgent&assignee=me&updatedAfter=2026-08-05T00%3A00%3A00.000Z"
```

Pagination cursors are bound to the exact filter set. Reusing a cursor after changing a filter is
a `400 BAD_REQUEST`; restart that filtered query without `after` instead.

The same credential may use `GET /v1/tasks/mine` for tasks assigned to its bot identity. Updates
and Kanban moves use the existing optimistic `expectedVersion` contract and their own stable
idempotency keys. A stale version returns `409 CONFLICT`; read the board again before retrying.

Every response from the bot-friendly channel-slug list/create routes and the two single-task lookup
routes includes `createdBy` and `updatedBy`. A create attributes both fields to the bot; edits,
assignments, Kanban moves, and automatic unassignment record the member or bot that performed the
latest mutation. The original conversation-ID task routes keep their prior wire shape for desktop
compatibility; use a lookup route when a bot needs fresh actor attribution after a patch or move.

`tasks:read` permits the two task-list routes. `tasks:write` permits create, update, and move
routes. Write responses include the canonical task that changed, but the scope does not permit list
access. Supplying a bearer credential selects bot authentication. An invalid or expired token does
not fall back to a human session cookie.
