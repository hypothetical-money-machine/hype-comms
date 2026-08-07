# HMM Chat platform plugin for Hermes

This directory is a drop-in Hermes platform plugin. It makes an HMM Chat agent
user a persistent Hermes participant while keeping `hmm-chat-cli` useful as an
independent automation client.

The adapter:

- validates the token with `hmm-chat-cli auth whoami --json`;
- loads bootstrap, member, and complete conversation metadata;
- starts `hmm-chat-cli watch --json --after <cursor>` and treats stdout as
  NDJSON only;
- wakes Hermes for every message in the agent's DMs and only explicitly
  mentioned channel messages;
- ignores the agent's own messages;
- uses the HMM Chat conversation UUID as Hermes's `chat_id` and a stable
  synthetic channel thread lane, so every author in one conversation resumes
  the same Hermes session;
- sends replies with message text on private stdin, never in process arguments;
- atomically checkpoints the last accepted decimal workspace cursor; and
- supports `deliver=hmm_chat` cron jobs in both live-gateway and standalone
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

Install the Node 24 `hmm-chat-cli` first and make sure the Hermes service
account can find it. For system services with a minimal `PATH`, set
`HMM_CHAT_CLI_PATH` to the executable's absolute path.

Copy this whole directory into the user platform-plugin category, then enable
it explicitly:

```sh
mkdir -p ~/.hermes/plugins/platforms
cp -R integrations/hermes-hmm-chat ~/.hermes/plugins/platforms/hmm-chat
hermes plugins enable platforms/hmm-chat
```

Keep the directory intact: Hermes needs `plugin.yaml`, `__init__.py`, and
`adapter.py`.

## Configure

Put configuration in Hermes's protected environment or secret store. If using
`~/.hermes/.env`, ensure it is readable only by the account running Hermes.

```dotenv
HMM_CHAT_API_ORIGIN=https://chat.example.invalid
HMM_CHAT_TOKEN=<agent-token>
HMM_CHAT_ALLOWED_USERS=<user-uuid>,<user-uuid>
```

Required:

- `HMM_CHAT_API_ORIGIN`: HTTPS, or loopback HTTP for local development. It must
  be an origin only and must not contain credentials, a path, query, or
  fragment.
- `HMM_CHAT_TOKEN`: a non-expiring, explicitly revocable HMM Chat agent token
  with `workspace:read` and `messages:write`.
- One access decision:
  - `HMM_CHAT_ALLOWED_USERS`: comma-separated HMM Chat user UUIDs; or
  - `HMM_CHAT_ALLOW_ALL_USERS=true`: an explicit workspace-wide opt-in.

Optional:

- `HMM_CHAT_HOME_CONVERSATION`: conversation UUID for cron jobs that use
  `deliver=hmm_chat` without another target.
- `HMM_CHAT_CLI_PATH`: executable name or absolute path. Default:
  `hmm-chat-cli`.
- `HMM_CHAT_HERMES_STATE_DIR`: private cursor-state root. Default:
  `$HERMES_HOME/state/hmm-chat` (or `~/.hermes/state/hmm-chat`).

The environment credential overrides any saved CLI profile and is never
persisted by the adapter. Do not put the token on a command line. HMM Chat
stores only a hash and reveals a token once; a lost token cannot be recovered.
Revoke it and create a replacement from an owner's human CLI profile.

The environment-enablement hook turns on `gateway.platforms.hmm_chat` when the
required values are present. An equivalent explicit platform entry is:

```yaml
gateway:
  platforms:
    hmm_chat:
      enabled: true
```

The adapter makes HMM Chat's platform-level group and thread sessions shared,
while retaining each message's real author UUID for Hermes authorization and
attribution. Hermes's default
`group_sessions_per_user: true, thread_sessions_per_user: false` is compatible.
Do not enable both `group_sessions_per_user` and
`thread_sessions_per_user`; the adapter refuses to connect because that
gateway-wide combination would split one HMM Chat channel into per-author
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
- Reply: sent back to the same HMM Chat conversation.
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
and agent user ID. A second local gateway cannot consume the same HMM Chat
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

Set `HMM_CHAT_HOME_CONVERSATION` and schedule with `deliver=hmm_chat`. The
registered standalone sender uses the same CLI transport:

```text
hmm-chat-cli messages send <conversation-uuid> --json
```

Message text is supplied on stdin. Attachments are not supported in this
adapter version.

## Verify

The tests install small fake modules at the real Hermes import paths and use
fake CLI processes, so Hermes itself is not required:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s integrations/hermes-hmm-chat -p 'test_*.py' -v
```

Coverage includes startup/bootstrap, scoped locking, DM delivery, mention
gating, self-message suppression, metadata cache updates, atomic cursor restart,
equal-cursor resync, cursor-expiry recovery, malformed NDJSON cleanup,
transient respawn recovery, private-stdin send, retry classification, cron
registration, and clean shutdown.
