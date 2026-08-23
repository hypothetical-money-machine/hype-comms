# Hype Comms platform plugin for Hermes

This directory is a Hermes platform plugin. It uses `hype-comms-cli` to connect a Hype Comms
agent member to a persistent Hermes session.

The adapter validates its token, loads workspace metadata, watches validated NDJSON events, and
stores its last accepted cursor atomically. It wakes Hermes for DMs and explicit channel mentions,
ignores the agent's own messages, sends reply text through stdin, and supports
`deliver=hype_comms` cron jobs. Message bodies are untrusted conversation content; the adapter
never treats them as configuration or system instructions.

Each Hype Comms conversation maps to one shared Hermes session. A channel reply can use the server
thread root. Direct-message replies remain flat.

## Compatibility

The plugin targets the public Hermes API at
`NousResearch/hermes-agent@f34a69b1cd7c5a6f73c2f7573634be07f666fc60` (2026-07-26). It uses
`BasePlatformAdapter`, `MessageEvent`, `MessageType`, `SendResult`, `Platform`,
`PlatformConfig`, and `PluginContext.register_platform(...)`.

Threading also uses the gateway's reply-anchor behavior and stream-consumer metadata. Review those
paths when updating the Hermes pin. The plugin sets `SUPPORTS_MESSAGE_EDITING = False` because
Hype Comms has no edit operation. It filters whole-response silence markers before delivery, so a
streaming segment cannot post `NO_REPLY` into a conversation.

No Hermes source is vendored here.

## Install

Install the Node 24 `hype-comms-cli` first. Set `HYPE_COMMS_CLI_PATH` to its absolute path when a
system service has a minimal `PATH`.

```sh
mkdir -p ~/.hermes/plugins/platforms
cp -R integrations/hermes-hype-comms ~/.hermes/plugins/platforms/hype-comms
hermes plugins enable platforms/hype-comms
```

Keep `plugin.yaml`, `__init__.py`, and `adapter.py` together. Channel threading requires a CLI
that accepts `messages send --thread-root-id`. An older CLI causes the first threaded reply to be
sent flat; the plugin then keeps threading off until the gateway restarts.

## Configure

Store configuration in the Hermes service account's protected environment or secret store. If you
use `~/.hermes/.env`, restrict it to that account.

```dotenv
HYPE_COMMS_API_ORIGIN=https://chat.example.invalid
HYPE_COMMS_TOKEN=<agent-token>
HYPE_COMMS_ALLOWED_USERS=<user-uuid>,<user-uuid>
```

| Setting | Meaning |
| --- | --- |
| `HYPE_COMMS_API_ORIGIN` | Required credential-free HTTPS origin, or loopback HTTP for development |
| `HYPE_COMMS_TOKEN` | Required non-expiring agent token with `workspace:read` and `messages:write` |
| `HYPE_COMMS_ALLOWED_USERS` | Required comma-separated Hype Comms user UUIDs, unless `HYPE_COMMS_ALLOW_ALL_USERS=true` |
| `HYPE_COMMS_HOME_CONVERSATION` | Optional conversation UUID used by cron delivery without an explicit target |
| `HYPE_COMMS_CLI_PATH` | Optional executable name or absolute CLI path |
| `HYPE_COMMS_HERMES_STATE_DIR` | Optional private cursor directory; default is `$HERMES_HOME/state/hype-comms` |
| `HYPE_COMMS_THREAD_REPLIES` | Optional; defaults to `true`. Set `false` to send replies flat. |
| `HYPE_COMMS_THREAD_FOLLOWUPS` | Optional; defaults to `false`. Enables unmentioned participated-thread follow-ups. |

The adapter reads the thread settings at construction. Restart the gateway after changing either
setting. The environment token overrides a saved CLI profile and is not stored by the adapter.
Hype Comms reveals an agent token once; revoke and replace a lost token from an owner's human CLI
profile.

The plugin enables `gateway.platforms.hype_comms` when required settings are present. You can
also enable it explicitly:

```yaml
gateway:
  platforms:
    hype_comms:
      enabled: true
```

The adapter shares Hype Comms group and thread sessions while preserving each message author's
identity for Hermes authorization. The default
`group_sessions_per_user: true, thread_sessions_per_user: false` works. Do not enable both
per-user session modes; the adapter rejects that configuration because it splits one Hype Comms
channel by author.

```sh
hermes gateway restart
hermes gateway status
```

## Trigger and delivery behavior

- Every direct message reaches Hermes after normal Hermes authorization.
- A channel message reaches Hermes when `mentionedUserIds` contains the agent ID.
- The adapter ignores its own messages.
- A channel response uses the triggering root when it is available. A missing or rejected root
  sends the response in the main timeline.
- A direct-message response always sends flat.
- Hermes tool-progress and interim messages send flat because Hermes does not provide this adapter
  with a reply anchor for them.
- The server rejects thread depths beyond one level.
- Owner and token administration use an owner's human CLI profile, not this adapter.

### Thread follow-ups

With `HYPE_COMMS_THREAD_FOLLOWUPS=true`, a reply in a thread where the agent has already
participated wakes Hermes without an explicit mention. The server sends the recipient-specific
`participated_thread_notifications-v1` marker, so the adapter can identify those replies without
keeping its own participation record.

Each matching reply enters the Hermes session and consumes an inference turn even if the model
returns a silence marker. Keep follow-ups off for mention-only behavior. In a workspace with
multiple agents, exclude peer agents from `HYPE_COMMS_ALLOWED_USERS` or keep the setting off to
avoid agents responding to one another.

## State and recovery

State is keyed by the credential-free API origin and agent user ID. The state directory is mode
`0700`; `cursor.json` is atomically replaced with mode `0600`.

On first start, the adapter stores the bootstrap cursor and watches only new events. Later starts
resume from the stored cursor. `system.resync_required` reloads member and conversation metadata,
stores the new bootstrap cursor, and starts a new watch. The adapter does not process expired
history.

The adapter takes Hermes's local lock for that origin and agent identity. A second local gateway
cannot consume the same Hype Comms agent. It keeps the cursor when a watch disconnects.

Thread roots stay in memory only, with a 512-entry oldest-first limit. Resync and restart remove
them. A reply without a root goes to the conversation's main timeline.

The adapter retries network, timeout, rate-limit, HTTP 5xx, and CLI exit-code 5 failures with
bounded full-jitter backoff. Configuration, authentication, authorization, validation, not-found,
and invalid-contract failures stop for operator action. Adapter logs remove tokens,
credential-bearing URLs, file paths, stack traces, and message bodies.

## Cron delivery

Set `HYPE_COMMS_HOME_CONVERSATION` and schedule with `deliver=hype_comms`. Cron messages are
top-level and read their body from stdin. This adapter version does not support attachments for
cron delivery.

```text
hype-comms-cli messages send <conversation-uuid> --json
```

## Verify

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s integrations/hermes-hype-comms -p 'test_*.py' -v
```

The suite uses fake Hermes modules at the real import paths and fake CLI processes. It covers
startup, locking, delivery gates, cursor recovery, malformed NDJSON, retry behavior, private-stdin
sends, thread anchors and fallback, cron registration, and shutdown.
