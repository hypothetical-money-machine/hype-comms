# Hype Comms platform plugin for Hermes

This directory is a drop-in Hermes platform plugin. It makes an Hype Comms agent
user a persistent Hermes participant while keeping `hype-comms-cli` useful as an
independent automation client.

The adapter:

- validates the token with `hype-comms-cli auth whoami --json`;
- loads bootstrap, member, and complete conversation metadata;
- starts `hype-comms-cli watch --json --after <cursor>` and treats stdout as
  NDJSON only;
- wakes Hermes for every message in the agent's DMs and only explicitly
  mentioned channel messages;
- ignores the agent's own messages;
- uses the Hype Comms conversation UUID as Hermes's `chat_id` and a stable
  synthetic channel thread lane, so every author in one conversation resumes
  the same Hermes session;
- sends replies with message text on private stdin, never in process arguments;
- atomically checkpoints the last accepted decimal workspace cursor; and
- supports `deliver=hype_comms` cron jobs in both live-gateway and standalone
  cron processes.

Received message bodies are untrusted conversation content. They are never
interpreted as plugin configuration or system instructions.

## Compatibility

The implementation targets the public Hermes plugin API on
NousResearch/hermes-agent commit
`f34a69b1cd7c5a6f73c2f7573634be07f666fc60` (2026-07-26):

- `gateway.platforms.base.BasePlatformAdapter`
- `gateway.platforms.base.MessageEvent`
- `gateway.platforms.base.MessageType`
- `gateway.platforms.base.SendResult`
- `gateway.config.Platform` and `PlatformConfig`
- `PluginContext.register_platform(...)` in `hermes_cli/plugins.py`
- `BasePlatformAdapter._acquire_platform_lock(...)` and
  `_release_platform_lock()`

No Hermes source is vendored here.

## Install

Install the Node 24 `hype-comms-cli` first and make sure the Hermes service
account can find it. For system services with a minimal `PATH`, set
`HYPE_COMMS_CLI_PATH` to the executable's absolute path.

Copy this whole directory into the user platform-plugin category, then enable
it explicitly:

```sh
mkdir -p ~/.hermes/plugins/platforms
cp -R integrations/hermes-hype-comms ~/.hermes/plugins/platforms/hype-comms
hermes plugins enable platforms/hype-comms
```

Keep the directory intact: Hermes needs `plugin.yaml`, `__init__.py`, and
`adapter.py`.

## Configure

Put configuration in Hermes's protected environment or secret store. If using
`~/.hermes/.env`, ensure it is readable only by the account running Hermes.

```dotenv
HYPE_COMMS_API_ORIGIN=https://chat.example.invalid
HYPE_COMMS_TOKEN=<agent-token>
HYPE_COMMS_ALLOWED_USERS=<user-uuid>,<user-uuid>
```

Required:

- `HYPE_COMMS_API_ORIGIN`: HTTPS, or loopback HTTP for local development. It must
  be an origin only and must not contain credentials, a path, query, or
  fragment.
- `HYPE_COMMS_TOKEN`: a non-expiring, explicitly revocable Hype Comms agent token
  with `workspace:read` and `messages:write`.
- One access decision:
  - `HYPE_COMMS_ALLOWED_USERS`: comma-separated Hype Comms user UUIDs; or
  - `HYPE_COMMS_ALLOW_ALL_USERS=true`: an explicit workspace-wide opt-in.

Optional:

- `HYPE_COMMS_HOME_CONVERSATION`: conversation UUID for cron jobs that use
  `deliver=hype_comms` without another target.
- `HYPE_COMMS_CLI_PATH`: executable name or absolute path. Default:
  `hype-comms-cli`.
- `HYPE_COMMS_HERMES_STATE_DIR`: private cursor-state root. Default:
  `$HERMES_HOME/state/hype-comms` (or `~/.hermes/state/hype-comms`).

The environment credential overrides any saved CLI profile and is never
persisted by the adapter. Do not put the token on a command line. Hype Comms
stores only a hash and reveals a token once; a lost token cannot be recovered.
Revoke it and create a replacement from an owner's human CLI profile.

The environment-enablement hook turns on `gateway.platforms.hype_comms` when the
required values are present. An equivalent explicit platform entry is:

```yaml
gateway:
  platforms:
    hype_comms:
      enabled: true
```

The adapter makes Hype Comms's platform-level group and thread sessions shared,
while retaining each message's real author UUID for Hermes authorization and
attribution. Hermes's default
`group_sessions_per_user: true, thread_sessions_per_user: false` is compatible.
Do not enable both `group_sessions_per_user` and
`thread_sessions_per_user`; the adapter refuses to connect because that
gateway-wide combination would split one Hype Comms channel into per-author
durable sessions.

Restart and inspect the gateway after configuration:

```sh
hermes gateway restart
hermes gateway status
```

## Trigger and delivery policy

- Direct message: always dispatched to Hermes after normal Hermes
  authorization.
- Channel: dispatched only when `mentionedUserIds` explicitly contains the
  agent user ID.
- Unmentioned channel traffic: ignored and not added silently to Hermes
  context.
- Self-authored message: ignored.
- Reply: sent back to the same Hype Comms conversation.
- Owner administration: intentionally unavailable through the adapter. Use an
  owner's human CLI profile to manage agents and tokens.

Hermes's configured authorization remains the final inbound gate. The adapter
provides validated author UUID and username metadata from the workspace
directory; it never trusts display metadata from message text.

## Cursor, locking, and recovery

State is scoped by SHA-256 of the credential-free API origin plus agent user
ID. The directory is mode `0700`; `cursor.json` is atomically replaced with
mode `0600`.

On a new installation, the adapter checkpoints bootstrap's current cursor
before starting watch, so it never answers historical messages. Existing
installations resume from their persisted cursor. At-least-once duplicate
events at or below that cursor are ignored.

The adapter acquires Hermes's machine-local scoped lock using the API origin
and agent user ID. A second local gateway cannot consume the same Hype Comms
identity. Disconnect terminates the watch child, releases the lock, and keeps
the cursor.

`system.resync_required` bypasses duplicate-cursor suppression. The adapter
replaces member/conversation caches from fresh validated CLI results,
checkpoints bootstrap's new cursor, and starts a new watch. It intentionally
does not answer history that can no longer be replayed safely.

Watch crashes and retryable spawn failures use bounded exponential full-jitter
backoff. For classified CLI failures, only exit code 5, timeouts, rate limits,
and HTTP 5xx/network conditions are retryable. Configuration, authentication,
permission, validation, not-found, and invalid-contract failures stop
permanently for operator attention.

Child stderr is sanitized and routed to the Hermes plugin log. Tokens,
credential-bearing URLs, filesystem paths, stack traces, and message bodies
are not copied into adapter errors.

## Cron delivery

Set `HYPE_COMMS_HOME_CONVERSATION` and schedule with `deliver=hype_comms`. The
registered standalone sender uses the same CLI transport:

```text
hype-comms-cli messages send <conversation-uuid> --json
```

Message text is supplied on stdin. Attachments are not supported in this
adapter version.

## Verify

The tests install small fake modules at the real Hermes import paths and use
fake CLI processes, so Hermes itself is not required:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s integrations/hermes-hype-comms -p 'test_*.py' -v
```

Coverage includes startup/bootstrap, scoped locking, DM delivery, mention
gating, self-message suppression, metadata cache updates, atomic cursor restart,
equal-cursor resync, cursor-expiry recovery, malformed NDJSON cleanup,
transient respawn recovery, private-stdin send, retry classification, cron
registration, and clean shutdown.
