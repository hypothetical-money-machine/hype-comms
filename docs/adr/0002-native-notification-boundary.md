# 2. Native notification trust, freshness, and action boundary

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

Hype Comms needs to attract attention to a fresh direct message or server-verified mention while
the desktop process is already running. Realtime is at-least-once, the renderer owns a durable
encrypted replica and acknowledgement cursor, and on macOS the process can outlive its last
window. A native toast therefore cannot be treated as a renderer effect or as evidence that the
UI durably applied an event.

The former notification bridge did not meet that boundary. Its `open-channel` action was not
scope-bound, its in-memory queue was unbounded, and main attempted to flush at
`did-finish-load` before a production React subscriber existed. There was no exact message/thread
target, renderer-ready handshake, live-event freshness classification, or authoritative thread
participation reason.

The implementation must also preserve the privacy default: a renderer must never gain a generic
native title/body/action capability, and message content must not enter notification bookkeeping,
logs, metrics, click actions, or headless capture artifacts while previews are disabled.

## Decision

### Ownership and durable-state separation

Electron main is the only layer that evaluates notification eligibility or constructs a native
notification. It consumes a strictly validated canonical `message.created` event and an
authorized, bounded projection of conversation and member metadata. The renderer reports bounded
activity and handles exact navigation; it cannot request arbitrary notification content or choose
a target.

Notification evaluation and presentation are outside renderer event delivery and acknowledgement.
The notification controller's watermark never advances, delays, or substitutes for the encrypted
replica cursor, sync cursor, read cursor, unread count, or mention count. Presenter failure is
consumed as one notification attempt and cannot reject event application, reconnect realtime, or
cause replay for notification's sake.

The controller/presenter integration must remain default-off unless main has all of these
prerequisites:

- generation- and scope-safe realtime delivery;
- fail-closed handling for malformed or unknown realtime frames;
- membership-removal purge and authoritative repair before durable acknowledgement; and
- a proven windowless catch-up contract. Until the last item passes integration tests, closing the
  last macOS window stops realtime. Windows and Linux retain their existing last-window quit
  behavior.

The current implementation satisfies the first three prerequisites and uses the prescribed
last-window stop fallback for the fourth. That permits explicit evidence builds, not default
rollout; the build and device defaults remain off until the deterministic and installed-platform
gates in the roadmap pass.

### Freshness, scope, and deduplication

The authoritative bootstrap cursor seeds an ephemeral notification watermark before realtime
starts. Startup replay, HTTP catch-up, and authoritative rebuilds may repair the renderer replica
but are always quiet. A strictly validated, scope-matching `system.connected` raises the
notification watermark to its `workspaceSequence` and arms only that event's `connectionId`.

`offline`, `reconnecting`, a replacement socket, an invalid frame, or a session transition disarms
notification eligibility. A later matching `system.connected` re-arms it without lowering or
clearing the current signed-in scope's watermark. Only a validated `message.created` delivered by
the armed connection after that boundary reaches policy evaluation. Event ID and monotonically
increasing workspace sequence suppress duplicate or reconnect replay.

Main bounds the pre-`system.connected` replay buffer to 1,024 events and 4 MiB of serialized
frames, with the same 4 MiB cap on each WebSocket frame. An overflow closes that socket without
reconnecting from the same cursor and retains only a body-free `system.resync_required` control
bound to the exact user/workspace. `startWorkspaceRealtime` is the renderer subscription
handshake: the control is redelivered while the supplied durable cursor is unchanged, and only a
strictly newer cursor from completed HTTP recovery consumes the latch and opens a new socket.
Renderer navigation invalidates delivery readiness; a failed ordinary event delivery likewise
pauses realtime for catch-up instead of silently consuming UI history. Sign-out, scope
replacement, and shutdown purge the latch.

The controller retains one monotonic watermark and at most the latest 1,024 event IDs for the
active user/workspace/session generation. It clears the scope on sign-out, user/workspace
replacement, or shutdown. A conversation-membership removal immediately blocks the conversation,
closes its live notifications, purges its pending actions, and remains blocked until an
authoritative catalog refresh confirms access.

### Initial eligibility policy

The policy is pure and body-free. It produces either an eligible reason plus presenter class, or a
content-free suppression reason. It cannot mutate a cursor or invoke Electron.

For the initial slice, an otherwise eligible message uses the first matching reason:

1. the signed-in user ID occurs in the server-verified `mentionedUserIds`;
2. the authorized conversation is `direct_message`.

A message satisfying both rules produces one verified-mention notification. Human-, bot-, and
agent-authored messages follow identical rules. A null author, the signed-in user's own message,
an ordinary channel message, and the reserved `group_direct_message` kind are quiet. Mention-like
body text is never parsed. Participated-thread replies remain deferred until a capability-gated
server event supplies a recipient-specific reason; main must not infer participation from a
partially hydrated replica.

Scope mismatch, stale generation, replay/catch-up delivery, a disarmed or stale connection,
duplicate delivery, blocked or unknown conversation metadata, focus, current visibility, disabled
device preference, unsupported native capability, and denied OS permission all suppress an
otherwise eligible native reason. Headless automation still honors explicit device disablement but
otherwise keeps the same eligibility result and selects a capture presenter without consulting
host native support or OS permission; it never constructs the native presenter.

OS permission `unknown` may permit one presentation attempt. A denial or presenter failure becomes
a stable local capability state with no timer, prompt, presentation, or reconnect retry. Recovery
requires an explicit capability refresh.

### Focus and visibility

Authoritative `BrowserWindow` state and the latest accepted renderer activity revision form one
event-time snapshot. Main suppresses every notification while the window is focused. A message is
also currently visible only when the window is shown and not minimized, the current validated
activity reports the Chat pane for the exact conversation, and the applicable stream is at its
live tail:

- a top-level message uses `timelineAtLiveTail`;
- a reply uses only the matching thread root's `atLiveTail` value.

The timeline and thread pane can be visible simultaneously, so the activity contract reports both
streams independently. Selecting a conversation while scrolled into history, showing Tasks,
viewing another thread, hiding/minimizing the window, or having no current activity report does not
make the incoming message visible.

Main issues `sessionGeneration`, `rendererSessionGeneration`, user ID, and workspace ID through a
strict notification context. The renderer echoes that context in ready/activity messages. Main
binds every update to the trusted IPC event's `webContents.id`, rejects stale or equal monotonic
revisions, and invalidates activity on navigation, destruction, or session replacement. The
renderer cannot provide a `webContents.id`, and no wall-clock timeout defines staleness.

### IPC and preferences

`packages/contracts/src/notifications.ts` is the source of truth for strict, versioned schemas:

- device preference, content-preview preference, native support, and OS permission remain
  independent fields;
- main-issued active/inactive context supplies scope and renderer generation;
- activity reports only pane, exact conversation, timeline tail, and optional exact thread tail;
- `open-message` actions contain only generation, user/workspace/conversation/message IDs, and the
  nullable thread root; and
- a renderer-ready, scope-bound pull delivers at most 32 actions only after the subscription and
  workspace session exist, and main retains each action until an exact post-handling
  acknowledgement.

Every payload has an explicit raw UTF-8 JSON byte cap that is applied before Zod parsing: 256 bytes
for preferences; 512 bytes for state, context, and the drain request; 1,024 bytes for one action or
activity update; 2 KiB for one exact action acknowledgement; and 32 KiB for a full drain response.
Unknown fields, invalid UUIDs, unsafe generations/revisions, stale scope, and cross-scope action
batches are rejected. There is no generic title, body, sound, action button, URL, or native-options
schema.

Preferences are versioned, atomic, device-local state owned by main. Device enablement defaults
off until packaged rollout gates pass; message-body preview defaults disabled and requires a
separate explicit opt-in. Native support is `supported` or `unsupported`; OS permission is
`granted`, `denied`, or `unknown`. Do-not-disturb and sound remain operating-system policy.

Native notification code is also guarded at build time. `HMM_NATIVE_NOTIFICATIONS_ENABLED` accepts
only `0` or `1`; unset and `0` compile presentation off, report unsupported capability, and do not
construct a notification controller or presenter. `1` includes the controller for explicit
development, headless, or packaged-pilot evidence, but does not override the persisted device
preference. Changing the environment after a build cannot enable that artifact.

### Exact click actions and lifecycle

Main derives an `open-message` action from the retained canonical event. The action is body-free
and bound to the exact session generation, user, workspace, conversation, message, and nullable
thread root. A click restores/focuses the window and, on macOS, recreates it first when the process
is running without one. After current-scope catch-up and authorization, the conversation
controller resolves the message from the replica or uses a strict authorized by-ID hydration
operation. A missing or revoked target falls back only to an authorized conversation with a
non-sensitive explanation; a stale scope is discarded.

Readiness is renderer-initiated after its subscriber and workspace session are ready;
`did-finish-load` is not readiness. Drain and push delivery are at-least-once. Main removes an
action only after the exact trusted sender and current scope/generations acknowledge successful
handling; renderer-side bounded deduplication retries a failed acknowledgement without repeating
navigation. Pending actions remain memory-only, oldest-first, and capped at 32. Main retains at
most 128 live native notification handles and closes/removes them on click,
close, failure, oldest-first eviction, sign-out, scope replacement, or shutdown. Click guarantees
last only for the originating process lifetime.

The metadata label projection is derived from authorized bootstrap data, every paginated
conversation response, the at-most-25-member directory, and ordered invalidations. It is capped at
5,000 conversations. Reaching that cap disables presentation and requests authoritative repair;
main does not evict an arbitrary authorized conversation.

Unpackaged isolated headless clients select capture before any Electron native presenter can be
constructed. A private pinned directory receives bounded `notifications-<profile>.jsonl` records
containing only version, opaque capture ID, and eligibility reason. A strict headless-only IPC can
activate that ID only while its in-memory callback remains live; the artifact is never an action
store and contains no notification labels, target IDs, or body. Packaged and ordinary renderer
sessions cannot invoke the activation bridge.

## Consequences

- Default builds can carry policy, schemas, settings, and controller code without constructing an
  Electron `Notification`; explicit evidence builds and production rollout remain separately
  gated.
- Notification progress cannot create a second unread or sync source of truth, so a recreated
  renderer always resumes from its encrypted replica cursor and performs normal HTTP catch-up.
- Exact click-through requires a separately authorized by-ID message hydration contract rather
  than reinterpreting the former channel-only action.
- Thread participation requires server and rolling-client capability work before it can become a
  third reason.
- Ordinary tests and headless demos use fake/capture presenters and cannot depend on a developer's
  OS permission or emit a real toast. Installed-artifact evidence across the supported native
  matrix remains a release gate.
