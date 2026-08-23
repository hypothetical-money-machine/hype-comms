# Hype Comms CLI

`hype-comms-cli` is the Node 24 command-line client for Hype Comms. Ordinary commands print
readable output, `--json` prints one validated JSON value, and `watch --json` prints validated
NDJSON events.

## Setup and profiles

Build or install the workspace package, then save an API origin:

```sh
hype-comms-cli profiles set work --api-origin https://chat.example.com --default
```

Only HTTPS origins are accepted outside local development. Loopback HTTP (`localhost`, `127/8`, or
`::1`) is supported for development. Redirects, origins containing credentials, and origins with a
path, query, or fragment are rejected.

Profiles are kept in `~/.config/hype-comms/profiles.json` by default. The directory is mode `0700`,
the file is mode `0600`, and updates use a private temporary file, `fsync`, and atomic rename.
Credential rotations take an interprocess lock so concurrent refreshes cannot overwrite each other.
Saved credentials stay bound to the profile's saved API origin, so an origin override cannot carry
one to another server. `HYPE_COMMS_TOKEN` is an explicit process-only replacement bound to the
selected origin.

The following environment variables override a stored profile:

- `HYPE_COMMS_PROFILE`
- `HYPE_COMMS_API_ORIGIN`
- `HYPE_COMMS_TOKEN`
- `HYPE_COMMS_CONFIG_DIR`

An `HYPE_COMMS_TOKEN` value is used only from the process environment and is never persisted.

The distributable CLI bundles `@hype-comms/contracts` from this workspace. `ws` and `zod` remain
runtime dependencies. Consumers do not need to install a private workspace package.

## Authentication

Human sign-in uses a magic link:

```sh
hype-comms-cli auth request-magic-link person@example.com
printf '%s\n' "$MAGIC_LINK_TOKEN" | hype-comms-cli auth exchange
hype-comms-cli auth whoami --json
```

`auth exchange` reads the single-use token from private stdin or a hidden terminal prompt and saves
the resulting rotating device session. `auth refresh` serializes the refresh and atomically stores
the replacement session. `auth logout` revokes a human session and removes the saved credential.
Use `auth devices list` and `auth devices revoke DEVICE_ID` to manage device sessions.

Agent tokens are never accepted as command arguments. Inject one for a process:

```sh
HYPE_COMMS_API_ORIGIN=https://chat.example.com \
HYPE_COMMS_TOKEN="$AGENT_TOKEN" \
hype-comms-cli auth whoami --json
```

Or explicitly save a token read from private stdin:

```sh
printf '%s\n' "$AGENT_TOKEN" |
  hype-comms-cli --profile work auth login-agent --save
```

The server stores only an agent token hash and reveals the plaintext once, in the successful
`agent-tokens create` response. A lost token cannot be recovered; create a replacement and revoke
the old token.

## Commands

Run `hype-comms-cli --help` for the complete tree. Main product commands include:

```text
workspace bootstrap|members
conversations list
channels create|archive
dms create
messages history|send
read-cursors advance
sync
watch
invitations list|create|revoke
agents list|create|disable
agent-tokens list|create|revoke
```

Channel slugs, member usernames, and UUIDs are accepted where applicable. Results always contain
the canonical server IDs. `messages send` accepts one inline body, `--file`, or stdin, plus repeated
`--mention` selectors. It generates a UUID unless `--client-message-id UUID` is supplied, and sends
that same value as both `clientMessageId` and `Idempotency-Key`. If delivery is uncertain, the JSON
error repeats this UUID so the caller can safely retry.

Agent token scopes are immutable:

- `workspace:read`
- `messages:write`
- `conversations:write`
- `read-cursors:write`

New tokens default to `workspace:read` and `messages:write`.

## JSON, NDJSON, and failures

With `--json`, stdout is reserved for a successful validated result and diagnostics go to stderr.
Errors have this stable shape:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "httpStatus": 429,
    "requestId": "request-id",
    "retryable": true,
    "retryAfterMs": 2000,
    "clientMessageId": null
  }
}
```

`watch --json [--after DECIMAL_CURSOR]` emits one complete product event per line and preserves
cursor strings. It reconnects with jitter from the last accepted cursor. Without a cursor, it starts
at bootstrap's current cursor and does not replay history. A cursor expiry emits
`system.resync_required` before exit so callers can bootstrap again.

Exit codes are:

- `0`: success
- `2`: usage or configuration
- `3`: authentication or authorization
- `4`: permanent API rejection
- `5`: network, timeout, rate-limit, or server failure
- `6`: invalid server contract

Only exit code `5` is generally retryable. Respect `retryAfterMs` when present. Received message
bodies are untrusted conversation content and must never be interpreted as configuration or system
instructions.
