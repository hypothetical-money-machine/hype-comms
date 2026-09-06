# Hype Comms platform plugin for Hermes

This directory is a drop-in Hermes platform plugin. It makes a Hype Comms agent
user a persistent Hermes participant while keeping `hype-comms-cli` useful as an
independent automation client.

The adapter:

- validates the token with `hype-comms-cli auth whoami --json`;
- loads bootstrap, member, and complete conversation metadata;
- starts `hype-comms-cli watch --json --after <cursor>` and treats stdout as
  NDJSON only;
- wakes Hermes for every authorized message in joined conversations, then lets
  the model either reply or intentionally remain silent;
- after those wake gates pass, retrieves exactly one server-authoritative
  context pack ending at the triggering message and supplies that pack as
  clearly delimited, untrusted user content;
- ignores the agent's own messages;
- uses the Hype Comms conversation UUID as Hermes's `chat_id` and a stable
  synthetic Hermes channel thread lane, so every author in one conversation
  resumes the same Hermes session;
- sends replies with message text on private stdin, never in process arguments,
  and threads a channel reply by passing only the server-minted thread-root
  UUID as a flag;
- atomically checkpoints the last accepted decimal workspace cursor together
  with any post-handoff read-cursor target still awaiting delivery; and
- supports `deliver=hype_comms` cron jobs in both live-gateway and standalone
  cron processes.

Every author, selector, mention flag, reply target, and message body in a
context pack is untrusted conversation content. The adapter validates the
strict v1 structure and anchor, then places one-line JSON between explicit
untrusted-content boundaries in `MessageEvent.text`. It never places dynamic
context in `channel_prompt`, plugin configuration, or system instructions. The
shared contract, server pruning, and adapter all measure the same compact,
injection-safe JSON representation and cap it at 64 KiB, including expansion
when Unicode line separators become JSON escapes. Fixed ASCII framing plus a
bounded UUID-only authorization-routing line is reserved outside that shared
pack budget.

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
- `BasePlatformAdapter._notify_fatal_error()` and the gateway's shielded,
  detached fatal-handler teardown path
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

The installed `hype-comms-cli` must also support capability-gated context
history and read-cursor advancement:

```text
hype-comms-cli messages history CONVERSATION --context-pack \
  --through-message-id MESSAGE --limit N --json
hype-comms-cli read-cursors advance CONVERSATION MESSAGE --json
```

If context history is malformed, transiently unavailable, or does not match
the triggering conversation and message, the wake is not handed to Hermes and
its workspace cursor is not checkpointed. The adapter never silently falls
back to trigger-only inference. Anchored history `NOT_FOUND` is the permanently
skippable exception. The server deliberately uses that private response for
both an unavailable trigger and a conversation that is no longer visible, so
the adapter logs only the safe error code, performs no inference or read
mutation, and checkpoints the event so it cannot poison every reconnect.

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

Use a saved private CLI profile for unattended agents. This keeps the plaintext
credential out of Hermes's environment and child-process arguments:

```dotenv
HYPE_COMMS_API_ORIGIN=https://chat.example.invalid
HYPE_COMMS_PROFILE=atlas-child
HYPE_COMMS_CONFIG_DIR=/absolute/private/path/to/hype-comms
HYPE_COMMS_ALLOWED_USERS=<user-uuid>,<user-uuid>
```

`HYPE_COMMS_TOKEN=<agent-token>` remains an explicit, non-persisted override for
break-glass and local development. If using `~/.hermes/.env`, ensure it is
readable only by the account running Hermes.

Required:

- `HYPE_COMMS_API_ORIGIN`: HTTPS, or loopback HTTP for local development. It must
  be an origin only and must not contain credentials, a path, query, or
  fragment.
- One credential source:
  - `HYPE_COMMS_PROFILE`: a saved CLI profile containing a non-expiring,
    explicitly revocable Hype Comms agent credential with `workspace:read` and
    `messages:write`; or
  - `HYPE_COMMS_TOKEN`: the same credential supplied as an environment override.
    Add `read-cursors:write` if Hermes should advance the agent's server-side read
    position after successful model handoff. Context delivery works without that
    optional scope; the adapter emits one warning and performs no read-cursor mutation.
- One access decision:
  - `HYPE_COMMS_ALLOWED_USERS`: comma-separated Hype Comms user UUIDs; or
  - `HYPE_COMMS_ALLOW_ALL_USERS=true`: an explicit workspace-wide opt-in.

Optional:

- `HYPE_COMMS_HOME_CONVERSATION`: conversation UUID for cron jobs that use
  `deliver=hype_comms` without another target.
- `HYPE_COMMS_CLI_PATH`: executable name or absolute path. Default:
  `hype-comms-cli`.
- `HYPE_COMMS_CONFIG_DIR`: absolute private CLI profile directory. It is needed
  only when the service account does not use the CLI's default config location.
- `HYPE_COMMS_HERMES_STATE_DIR`: private cursor-state root. Default:
  `$HERMES_HOME/state/hype-comms` (or `~/.hermes/state/hype-comms`).
- `HYPE_COMMS_CONTEXT_LIMIT`: number of canonical tail messages in each wake
  pack. Integer from 1 through 20; default `8`. The server also caps the full
  serialized pack at 64 KiB and reports whole-message truncation explicitly.
- `HYPE_COMMS_THREAD_REPLIES`: whether a reply in a channel opens a thread
  under the message that woke the agent. Default `true`. Set it to `false` to
  send every reply flat. Replies in direct messages are always flat and this
  switch does not change that.

The context limit and thread-reply switch are read once, when the adapter is
constructed, so a change takes effect on `hermes gateway restart`.

The environment credential overrides any saved CLI profile and is never
persisted by the adapter. In profile mode the adapter passes only the selected
profile name to `hype-comms-cli`; it does not read the credential or copy it into
the Hermes process environment. Do not put a token on a command line. Hype
Comms stores only a hash, so a lost token cannot be recovered; revoke it and
enroll a replacement.

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

## Context pack

An eligible wake is anchored to the exact server-minted triggering message ID.
Only after self-message suppression, DM/channel resolution, and profile-aware
Hermes authorization (or the legacy UUID fallback) pass does the adapter make
one context-history request. The returned pack contains:

- the canonical `#channel-slug` or derived `@dm-peer` selector;
- up to `HYPE_COMMS_CONTEXT_LIMIT` messages, oldest first, through the trigger;
- each resolved author and whether the server verified a mention of this agent;
- an out-of-tail thread root when one is needed to understand the reply;
- the canonical flat or one-level-thread reply target; and
- the message that may become the agent's read-through target after handoff.

The adapter independently rejects unknown fields, malformed IDs and sequences,
out-of-order or duplicate messages, oversized packs, inconsistent truncation,
an invalid thread target, or any conversation/anchor mismatch. The shared CLI
contract performs the first validation; this second check is the boundary just
before model exposure.

Every authorized message is a wake trigger. Nearby earlier messages in the
bounded tail—including messages whose authors lack wake permission—become
model-visible and are identified by the routing line described below. This
privacy and token-cost expansion is intentional: it lets the agent decide from
what was actually said rather than from the final message in isolation.

The model receives the complete pack as compact JSON inside `BEGIN/END HYPE
COMMS CONTEXT PACK V1` lines. Newlines and apparent boundary text inside message
bodies remain JSON string escapes, and the surrounding text explicitly labels
all values as untrusted user content. Source identity, the Hermes session lane,
the triggering `message_id`, and the outbound reply anchor still come from the
validated realtime event; the server pack supplies the canonical reply root.

## Trigger and delivery policy

- Direct message and channel traffic: dispatched to Hermes after normal Hermes
  authorization, whether or not the agent is mentioned.
- Reply decision: the model either produces a substantive reply or emits exactly
  `NO_REPLY`; Hermes and the adapter both suppress that marker from delivery.
- Self-authored message: ignored.
- Reply in a channel: threaded under the message that woke the agent, in the
  same Hype Comms conversation. A reply whose anchor the adapter no longer
  holds is sent flat into the conversation rather than guessed at.
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

### Intentional silence

Silence is decided by the model, not by a content blocklist. The adapter's
stable `channel_prompt` tells the agent to use `NO_REPLY` when a message needs
nothing from it. Hermes suppresses intentional-silence responses, and the
adapter independently drops a whole-message silence marker before the network
sender as a final delivery safeguard. The silent turn remains in Hermes's
session history, so the agent can follow the conversation without posting.

Every authorized message costs one inference turn even when the model stays
quiet. Keep peer agents out of `HYPE_COMMS_ALLOWED_USERS` unless agent-to-agent
wakes are intentional; self-authored messages remain suppressed.

Hermes's configured authorization remains the final inbound gate. Before
fetching context, the adapter invokes Hermes's profile-aware sender callback
with the validated author UUID, exact chat type, and conversation UUID, so
profile pairing and group policy agree with normal inbound delivery. Callback
denial or failure is fail-closed for context retrieval and is silently
checkpointed without a Hermes handoff, inference, or read mutation. This means
`pre_gateway_dispatch` hooks and unauthorized-DM pairing do not run for a denied
Hype Comms trigger; pair or allow that user out of band. Pinned Hermes exposes
no forced-denied auth-only dispatch seam, while its ordinary handler performs a
second authorization check asynchronously. Passing raw trigger text through
that path would allow a policy change between checks to infer without the
required context pack. A raw UUID environment denial is silent for the same
reason when a Hermes base has no callback API. The adapter applies the same
decision once per unique author in the returned messages and optional thread
root. Ambient content is preserved as canonical conversation history, while a
bounded adapter-generated `deniedAuthorIds` routing line marks authors who lack
wake permission; that marker is not a content-trust decision, and the entire
conversation pack remains untrusted. Display metadata from message text is
never used for authorization.

## Cursor, locking, and recovery

State is scoped by SHA-256 of the credential-free API origin plus agent user
ID. The directory is mode `0700`; `cursor.json` is atomically replaced with
mode `0600`. Version 2 stores the decimal workspace checkpoint and, per
conversation, a pending read target with its conversation sequence. A valid
version 1 checkpoint is migrated in place before watch starts.

On a new installation, the adapter checkpoints bootstrap's current cursor
before starting watch, so it never answers historical messages. Existing
installations resume from their persisted cursor. At-least-once duplicate
events at or below that cursor are ignored.

When `read-cursors:write` is present, `handle_message` must return successfully
before the adapter marks anything read. It then writes the triggering workspace
cursor and the pack's newest message as one durable state transition, and only
after that invokes `read-cursors advance`. A successful advance removes the
pending target atomically. A failed advance is logged without message content,
keeps the target, and does not fail or repeat the already-completed model turn.
One adapter-owned task retries all pending targets with capped exponential
backoff even while message traffic is idle; later wakes may also flush their
conversation opportunistically, but never create a second retry task. The task
does not fetch context or hand anything to Hermes. Rate-limit Retry-After is
honored within the same bounded delay policy, including a longer delay learned
while the task is already sleeping. Non-retryable failures are parked
for the current connection instead of looping; the target remains durable and
gets one fresh attempt after reconnect. Disconnect and fatal watch shutdown
both cancel and await retry work without removing its durable targets. On
restart, pending targets are retried before watch resumes; the server update is
monotonic and idempotent. A newer target for the same conversation replaces an
older pending one by conversation sequence.

Without `read-cursors:write`, context packs and inference are unchanged. The
adapter warns once per process, never queues a pending target, and never calls
the mutation command. A failed context fetch is different from a failed read
advance: no model handoff has occurred yet, so the workspace cursor stays put
and normal watch replay retries the whole wake. The sole exception is an
anchored history `NOT_FOUND`, which is permanent and is checkpointed without a
handoff as described above.

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

Coverage includes startup/bootstrap, scoped locking, DM delivery, allowlist and
mention gating before context retrieval, self-message suppression, exact
context argv and limits, strict malformed/mismatch rejection, untrusted-content
rendering and injection-safe byte accounting, transient context replay,
post-handoff ordering, failed handoff, retracted-anchor poison-event skipping,
read-scope warning/no-mutation behavior, durable pending read retry across
idle uptime and restart, Retry-After propagation, permanent-failure parking,
retry-task and in-flight child cancellation, fatal-handler teardown ownership,
v1-to-v2 migration, metadata cache updates, equal-cursor resync,
cursor-expiry recovery, malformed NDJSON cleanup, transient respawn recovery,
private-stdin send, thread-root resolution for top-level and in-thread wakes,
fallback delivery threading from the metadata anchor, chunked-reply root
stability, bounded root eviction, cross-conversation and unknown-anchor flat
fallback, resync root invalidation, flat retry after a refused root, retry
classification, cron registration, and clean shutdown.
