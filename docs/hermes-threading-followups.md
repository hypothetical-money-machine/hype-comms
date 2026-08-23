# Hermes threading

The Hermes adapter supports Hype Comms threads. It sends a channel reply with
`hype-comms-cli messages send --thread-root-id` when it has the root that woke the agent. Direct
message replies stay in the main timeline. Hype Comms permits one thread level, so a reply to a
reply uses the original root.

`HYPE_COMMS_THREAD_REPLIES` defaults to `true`. Set it to `false` to send every answer flat. If
the adapter has no root, the server refuses the root, or the installed CLI lacks
`--thread-root-id`, it retries the message flat. The adapter keeps threading disabled for the
rest of that process after an unsupported CLI response. A spawn failure does not disable
threading.

The desktop currently hides replies from the main timeline when their root is present. This works
for channel discussion. A threaded reply in a direct conversation would put the agent's answer
behind a reply chip, so the adapter never threads direct-message replies.

## Follow-ups

`HYPE_COMMS_THREAD_FOLLOWUPS` defaults to `false`. When enabled, an unmentioned reply wakes the
agent only if the server marks it as a reply in a thread where that agent has participated. The
adapter receives the marker through `participated-thread-notifications-v1`; the marker is
recipient-specific and does not alter the conversation audience.

Follow-ups add each matching message to the Hermes transcript and spend an inference turn even
when Hermes responds with no message. Keep the setting off for normal mention-only behavior.
When several agents share a thread, exclude peer agents from `HYPE_COMMS_ALLOWED_USERS` or leave
follow-ups off to avoid agent-to-agent exchanges.

Hermes treats a whole response of `[SILENT]`, `SILENT`, `NO_REPLY`, or `NO REPLY` as no
delivery. The adapter repeats that check before sending so a streaming segment cannot post a
silence marker. Blank and failed turns remain errors.

## Sessions and recovery

One Hype Comms conversation maps to one shared Hermes session. Threaded and flat messages in the
same conversation use that session. The adapter rejects the gateway configuration that combines
per-user group and per-user thread sessions because it would split a channel by author.

The adapter checkpoints its cursor atomically and ignores duplicate events at or below that cursor.
On `system.resync_required`, it reloads member and conversation data, stores the new bootstrap
cursor, and starts a new watch without processing expired history. Thread roots are memory-only,
bounded to 512 entries, and cleared by resync or restart. A missing root produces a flat reply.

## Open work

The desktop removes a thread summary when its root leaves the loaded message window. That affects
all threads, including Hermes threads, and needs a desktop fix. Real-traffic review is also needed
for replies that use the participated-thread notification path.
