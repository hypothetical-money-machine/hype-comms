# Hermes threading: what shipped, and what is still open

## Status

Threading and its follow-ups are implemented in the working tree. The adapter resolves the thread
root a reply must be filed under and passes it to `hype-comms-cli messages send --thread-root-id`,
replies in channels thread while replies in direct messages stay flat, and the agent can be woken by
an unmentioned follow-up inside a thread it has already spoken in and decide for itself whether to
answer. `npm run check` passes, which includes the adapter's 69 tests.

The whole depth rule still lives in one place, `_resolve_thread_root`. Hype Comms threads are exactly
one level deep, enforced by the `enforce_message_thread_depth` trigger in
`apps/server/src/db/migrations/0009_message_threads.sql`, so the root of a reply is that reply's own
root and the root of a top-level message is the message itself. Two safety behaviours keep threading
presentational rather than load-bearing: if the server rejects a thread root the adapter retries the
send flat, and if the CLI turns out not to understand `--thread-root-id` it latches threading off for
the rest of the process. Neither path can swallow the agent's answer.

That latch got narrower along the way. It fired on the CLI's usage exit code, which the adapter also
mints for its own pre-spawn failures, so a single transient `OSError` while spawning a subprocess
could disable threading for the life of the gateway and log a warning blaming a CLI that was working.
It now excludes the codes the adapter raises before the CLI ever runs.

Outside the integration directory, one thing changed: `packages/cli/src/watch.ts` now negotiates
`participated-thread-notifications-v1` alongside the two capabilities it already asked for.

## The timeline question, and how it was answered

`visibleTimelineMessages` in `apps/desktop/src/renderer/src/App.tsx` filters out every message with a
non-null `threadRootId` whenever threads are supported, and the desktop negotiates
`THREADS_CAPABILITY` unconditionally in `apps/desktop/src/main/workspace-transport.ts`. So the moment
the agent's reply becomes a thread reply, it leaves the main timeline and moves behind a reply chip.

In a channel that is the point: the root keeps its place in the conversation and grows a reply
counter, which is exactly what threading is for and what every other participant's threaded reply
does. In a direct message it is a bug in everything but name, because a one-to-one conversation turns
into a list of the human's own questions with the answers filed out of sight. It gets worse whenever
the root leaves the loaded window, since `workspace-runtime.ts` drops any thread summary whose root
is no longer among the loaded messages: the chip goes with it and the reply has no surface at all.

The answer taken here is that threading is not unconditional. `_threading_enabled_for` returns true
only for channels, and `HYPE_COMMS_THREAD_REPLIES=false` turns it off everywhere. The gate sits at
the point where a root is recorded rather than at the point where a reply is sent, because an anchor
that was never recorded already resolves to nothing and degrades to a flat send — the pre-threading
behaviour, reached through a path that was already tested.

What this does not fix is the pruning behaviour in channels. A thread whose root is no longer loaded
loses its chip, and that is true of every thread in Hype Comms, not just the ones an agent writes in.
It is a desktop question rather than an adapter one and it is untouched here.

## The participated-thread capability annotates, it does not enable

An earlier draft of this document said that waking the agent on replies in threads it has
participated in would first require adding `PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY` to
`WATCH_CAPABILITIES` in order to receive those events at all. That was wrong.

The audience for a `message.created` event is the whole conversation audience, computed in
`apps/server/src/modules/workspace/repository.ts` with no reference to threading. The insert that
records `participated_thread_reply` selects from that same audience and only layers a per-recipient
reason on top of it, into a side table; `#mapEvent` then attaches `recipientNotificationReason` to
the payload only when the capability was negotiated, rebuilding the payload from canonical fields so
a reason can never leak through shared event JSON. For a websocket the negotiation happens on the
`POST /v1/realtime/tickets` request and rides on the ticket, since the upgrade itself carries no
headers.

So the adapter already received every thread reply in every conversation it belongs to, and threw
them away itself at the one-line mention gate in `adapter.py`. The capability buys precision, not
access: it tells the adapter which thread replies belong to threads the agent has actually written
in, so it can wake on those and ignore the rest rather than waking on all thread traffic or keeping
its own participation ledger. That is why the CLI change is justified on its own terms — it is a
shared file, and the only thing it changes for every other consumer is an optional field appearing on
some `message.created` payloads.

## Letting the model decide when to stay quiet

Hermes recognises four whole-response markers — `[SILENT]`, `SILENT`, `NO_REPLY`, `NO REPLY` — and
suppresses delivery when a successful turn consists of exactly one of them. The guards are the ones
you would want: prose that merely mentions a marker is delivered normally, a blank response is an
error rather than silence, and a failed turn is never swallowed. The silent turn stays in session
history, so the agent keeps following a thread without posting into it.

Two things had to be built around that.

The first is telling the agent the rule, including who it is. `platform_hint` cannot do the whole
job: it is captured once at plugin registration, so it can name neither this workspace's agent
username nor whether the operator enabled follow-ups. The supported per-message seam is
`MessageEvent.channel_prompt`, which Hermes merges into the ephemeral system prompt at API-call time
and never persists — the same seam Slack uses to tell the model its own handle. `metadata` and
`raw_message` reach no prompt at all. The adapter's `channel_prompt` is deliberately constant for the
life of the process, because Hermes keys its agent cache on the merged ephemeral prompt and a prompt
that varied per message would rebuild the agent and miss the provider prompt cache every turn. The
rewritten `platform_hint` now states only what is true under every configuration.

The second is making the markers safe to instruct, which turned out to matter more than expected.
Hermes blanks a silent turn before delivery on the normal path, but its streaming path can seal a
segment mid-turn and hand the bare marker to `send()` as ordinary text — the shape you get when a
model emits the marker as the content of an assistant message that also carries a tool call, which is
precisely the ambient case.

The adapter now declares `SUPPORTS_MESSAGE_EDITING = False`, which is simply true, since Hype Comms
exposes no edit operation through the CLI. That was originally meant to be the fix, on the reading
that it makes the gateway skip streaming altogether. It does not: only one of the two
stream-consumer construction sites at the pinned commit is gated on the flag, and the other reads it
just to blank the typing cursor before building a consumer regardless. So the flag is worth keeping
on its own merits — it stops the gateway sending a partial preview it can never update — but it is
not a silence guarantee.

The guarantee is that `send()` drops any whole message that canonicalises to a silence marker,
mirroring Hermes's own matching rules, because a posted Hype Comms message cannot be retracted from
here. Worth remembering when the pin moves: a change to how the gateway seals segments cannot
reintroduce this, but a change to the marker set can, so the two lists have to move together.

## What the follow-up switch costs

`HYPE_COMMS_THREAD_FOLLOWUPS` defaults to off, so nothing about the shipped trigger policy changes
until an operator turns it on.

That default is deliberate. Deciding to stay quiet is a full inference turn, so a busy thread spends
tokens and rate limit for no visible output, and there is no cheaper filter available — the decision
is the model's by design. Turning it on also narrows a stated promise: unmentioned messages in
participated threads now do reach Hermes and stay in its transcript, so "not added silently to Hermes
context" stops holding for threads the agent has already joined. The allowlist still governs who may
wake the agent, so that protection is unaffected. The README states the narrowed promise directly
rather than leaving it implied.

## Session scoping

Unchanged, and still conversation-scoped. A Hermes session is a durable transcript keyed by session
ID; the adapter declares `group_sessions_per_user` and `thread_sessions_per_user` false, refuses to
start against a gateway that has both per-user group sessions and per-user thread sessions enabled
(the one combination that would still split a channel by author), and passes the conversation ID as
a synthetic thread lane for channels so sessions key per conversation while keeping the real author
ID for authorization and attribution.

The coupling to follow-ups is the reason to keep watching this. Today one shared transcript per
conversation stays clean because the agent only sees messages addressed to it. With follow-ups on,
every side conversation in every thread it has touched enters that same transcript, most of it turns
the model chose not to answer, and nothing dedupes or collapses repeated silent turns — the
transcript grows linearly until compression fires. If follow-ups become the default, per-thread
isolation is the thing to revisit, and it should be revisited as part of that change rather than
before it.

## Answered while implementing

Whether Hermes tool-progress messages carry a `reply_to` anchor: they do not. The progress anchor is
`None` on every platform except Feishu and Mattermost, and progress metadata never carries
`reply_to_message_id`. So with `display.tool_progress` enabled the bubbles land flat while the answer
threads. The README already said this; it is now verified rather than assumed.

## Still open

The desktop's thread-summary pruning, described above, which is a renderer question and affects all
threads rather than agent replies specifically.

Whether the notification path change behaves well on real traffic. The human who wrote the triggering
message now reaches the agent's reply through the `participated_thread_reply` notification rather
than as an ordinary new message. That is plausibly an improvement, but it is a different code path
and deserves a look outside tests.
