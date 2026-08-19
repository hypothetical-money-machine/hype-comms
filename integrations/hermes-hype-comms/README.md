# Hype Comms platform plugin for Hermes

This directory is a drop-in Hermes platform plugin. It makes an Hype Comms agent
user a persistent Hermes participant while keeping `hype-comms-cli` useful as an
independent automation client.

The adapter:

- validates the token with `hype-comms-cli auth whoami --json`;
- loads bootstrap, member, and complete conversation metadata;
- starts `hype-comms-cli watch --json --after <cursor>` and treats stdout as
  NDJSON only;
- wakes Hermes for every message in the agent's DMs and for explicitly
  mentioned channel messages, plus unmentioned follow-ups inside threads the
  agent has already written in when that is switched on;
- ignores the agent's own messages;
- uses the Hype Comms conversation UUID as Hermes's `chat_id` and a stable
  synthetic Hermes channel thread lane, so every author in one conversation
  resumes the same Hermes session;
- sends replies with message text on private stdin, never in process arguments,
  and threads a channel reply by passing only the server-minted thread-root
  UUID as a flag;
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
- `BasePlatformAdapter.send(..., reply_to=...)` receiving the value the adapter
  set as `MessageEvent.message_id`, via
  `gateway.platforms.base._reply_anchor_for_event`
- `gateway.stream_consumer._metadata_for_send` supplying that same anchor as
  `metadata["reply_to_message_id"]` on the fallback delivery path, which passes
  no `reply_to` (upstream internal, not public API)
- `gateway.stream_consumer` re-anchoring each sealed head chunk of a split
  streamed reply to the previous chunk's returned message ID (upstream
  internal, not public API)
- `BasePlatformAdapter.SUPPORTS_MESSAGE_EDITING`, which the gateway reads to
  decide whether to open a streaming preview at all
- `MessageEvent.channel_prompt`, applied as an ephemeral system prompt at
  API-call time and never persisted to transcript history
- The intentional-silence markers in `gateway.response_filters`
  (`[SILENT]`, `SILENT`, `NO_REPLY`, `NO REPLY`), matched against a whole
  response only

Threaded replies depend on the three anchor items. Treat them as review items
when bumping the pin: if the anchor stops matching, or the chunk chain re-sends
the original anchor instead, replies silently go flat and the fake-Hermes tests
cannot catch it.

This adapter sets `SUPPORTS_MESSAGE_EDITING = False`. Hype Comms exposes no
edit operation through the CLI, so without that declaration the gateway opens a
streaming preview, sends a partial first message, discovers that the edit
failed, and leaves the partial sitting beside the finished answer.

The flag is not the whole story for silence, though, and the difference matters.
At the pinned commit only one of the gateway's two stream-consumer construction
sites skips streaming on the flag; the other reads it merely to blank the
typing cursor and builds a consumer anyway. A consumer can seal a segment
mid-turn and hand a bare silence marker to `send()` as ordinary text, which is
exactly the shape a model produces when it decides to stay quiet after calling a
tool. So the adapter also filters whole-message silence markers on the way out.
That filter, not the flag, is what guarantees the word `NO_REPLY` is never
posted into someone's channel, because a posted Hype Comms message cannot be
retracted from here.

No Hermes source is vendored here.

## Install

Install the Node 24 `hype-comms-cli` first and make sure the Hermes service
account can find it. For system services with a minimal `PATH`, set
`HYPE_COMMS_CLI_PATH` to the executable's absolute path.

Threading needs a `hype-comms-cli` whose `messages send` accepts
`--thread-root-id`. The CLI reports a static version, so this is not checked at
startup; instead the first threaded reply against an older build is retried
immediately without the flag, the retry is logged at warning level, and the
adapter sends flat until it is restarted. No reply is lost, and no other
behavior changes.

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
- `HYPE_COMMS_THREAD_REPLIES`: whether a reply in a channel opens a thread
  under the message that woke the agent. Default `true`. Set it to `false` to
  send every reply flat. Replies in direct messages are always flat and this
  switch does not change that.
- `HYPE_COMMS_THREAD_FOLLOWUPS`: whether an unmentioned reply inside a thread
  the agent has already replied in wakes it. Default `false`. Read the trigger
  policy below before turning it on: it widens what reaches Hermes past
  explicit mentions, and it costs one inference turn per message even when the
  model decides to say nothing.

Both switches are read once, when the adapter is constructed, so a change takes
effect on `hermes gateway restart`.

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

Hermes's thread sessions and Hype Comms's message threads are unrelated. A Hype
Comms thread does not open a separate Hermes session; every author in one
conversation, threaded or not, resumes the same session. These gateway flags do
not change where a reply is placed.

Restart and inspect the gateway after configuration:

```sh
hermes gateway restart
hermes gateway status
```

## Trigger and delivery policy

- Direct message: always dispatched to Hermes after normal Hermes
  authorization.
- Channel: dispatched when `mentionedUserIds` explicitly contains the agent
  user ID.
- Unmentioned channel traffic: ignored and not added silently to Hermes
  context, unless it is a thread follow-up and `HYPE_COMMS_THREAD_FOLLOWUPS` is
  on. See the section below.
- Self-authored message: ignored.
- Reply in a channel: threaded under the message that woke the agent, in the
  same Hype Comms conversation. A reply whose anchor the adapter no longer
  holds is sent flat into the conversation rather than guessed at. Note that
  with follow-ups off, which is the default, the agent does not hear anything
  said inside the thread it just opened unless that message mentions it again.
  Threading puts the answer where a reply chip invites the human to continue,
  and the trigger policy has not moved, so this is the one place where the two
  pull against each other.
- Reply in a direct message: always flat, never threaded. A one-to-one
  conversation has no use for a thread, and a client that supports threads
  files threaded replies out of the main timeline, which in a direct message
  would leave the human reading their own questions with the answers hidden
  behind reply chips.
- Tool-progress and interim commentary bubbles: sent flat into the
  conversation, not into the thread. Hermes carries no reply anchor on those
  sends for this platform, so with `display.tool_progress` enabled the bubbles
  and the answer land in different places.
- Thread depth: exactly one level. A reply to a reply is filed under the
  original root, never under the reply; the server rejects anything deeper.
- Owner administration: intentionally unavailable through the adapter. Use an
  owner's human CLI profile to manage agents and tokens.

### Thread follow-ups

Off by default. With `HYPE_COMMS_THREAD_FOLLOWUPS=true`, a reply inside a
thread the agent has already replied in wakes it even though nobody mentioned
it, and the agent decides for itself whether to answer.

The adapter does not have to subscribe to anything to see those messages. It
already receives every `message.created` event for the conversations it belongs
to, and it discards the unmentioned ones itself. What the
`participated-thread-notifications-v1` capability adds is precision: the server
marks the thread replies that land in threads this agent has written in, so the
agent can wake on those alone instead of waking on all thread traffic or
keeping its own ledger of where it has spoken. The marking is per recipient and
never travels in the shared event payload.

Silence is decided by the model, not by a filter. Hermes suppresses delivery
when a whole response is one of its intentional-silence markers, and the
adapter's `channel_prompt` tells the agent to use `NO_REPLY` when a follow-up
needs nothing from it. The silent turn still enters Hermes's session history, so
the agent keeps following the conversation without posting into it.

Three consequences are worth stating before turning it on. Deciding to stay
quiet is a full inference turn, so a busy thread costs tokens and rate limit for
no visible output. Unmentioned messages in participated threads now do reach
Hermes and stay in its transcript, which narrows the promise made above: the
allowlist still governs who may wake the agent, but "not added silently to
Hermes context" stops holding for threads it has already joined.

The third is the one to check before turning this on in a workspace that runs
more than one agent. The adapter suppresses only its own messages, so where two
agents have both replied in the same thread, each one's reply wakes the other
and the exchange continues until one model chooses to stay quiet. Nothing in the
adapter breaks that cycle. Keep peer agents out of `HYPE_COMMS_ALLOWED_USERS`,
or leave follow-ups off, unless you have a reason to want agents answering each
other.

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

The thread root resolved for each dispatched message is held in memory only. It
is bounded at 512 entries with oldest-first eviction, dropped on
`system.resync_required`, and lost entirely on gateway restart. A reply whose
anchor is no longer held is sent flat into the conversation rather than dropped
or guessed at, so a restart mid-conversation, or a resync landing between two
chunks of one long reply, can leave part of an answer beside the thread instead
of inside it.

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
registered standalone cron sender uses the same CLI, always without a thread
root. Cron posts are top-level by design:

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
transient respawn recovery, private-stdin send, thread-root resolution for
top-level and in-thread wakes, fallback delivery threading from the metadata
anchor, chunked-reply root stability, bounded root eviction, cross-conversation
and unknown-anchor flat fallback, resync root invalidation, flat retry after a
refused root, retry classification, cron registration, and clean shutdown.
