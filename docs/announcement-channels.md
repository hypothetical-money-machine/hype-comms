# Announcement channels

> **Status:** Proposed. This specification describes a new feature; current source, contracts,
> and desktop behavior remain unchanged until its implementation lands.

## Decision summary

An announcement channel is a channel with an immutable `announcement` mode. It is not a new
conversation kind and it does not change channel visibility.

This v1 deliberately implements the initial publisher concept as **human workspace owners only**.
It creates neither a server/service publisher nor a new workspace administrator role.

- Only an active **human workspace owner** may create a top-level bulletin in an announcement
  channel.
- Any active principal that can see the channel may react to a bulletin or reply to it in its
  existing one-level thread, subject to the ordinary message scope checks.
- Announcement channels have no task project: no task board, task action, task API access, or
  task events.
- A server/service publisher and a broader administrator role are deferred. A channel owner is
  not a workspace administrator and does not gain bulletin-publishing authority merely by owning
  a members-only channel.

An **active human workspace owner** is a human principal whose current, authoritative workspace
membership is `active` with the `owner` role when the server handles the mutation. It excludes
agents, service credentials, cached client roles, channel ownership, and removed or suspended
memberships. In a members-only channel, current channel visibility is an additional requirement.

The desktop may use the product term “Announcement channel”. The server and contracts continue to
use the existing term “workspace” rather than introducing a second server abstraction.

## Goals

- Give workspace owners a clear broadcast surface for official updates.
- Keep member participation useful without allowing a second, unstructured main timeline:
  reactions and replies belong to a bulletin thread.
- Make the absence of tasks deliberate and comprehensible rather than a disabled or empty task
  board.
- Preserve existing channel access, durable sync, cache, idempotency, and one-level-thread
  guarantees.
- Keep the first release small enough to avoid a workspace-wide administrator/role-management
  redesign.
- Make capability-based rollout and intentionally degraded legacy behavior explicit, so a client
  capability never becomes an authorization grant.

## Non-goals

- A new `admin` workspace role, role-management UI, or changing owner-only administrative
  operations.
- Automated/server-authored bulletins. A future service publisher must have a real, auditable
  principal and an explicit narrow grant; it must not be an unauthenticated bypass or any agent
  with ordinary `messages:write` scope.
- Editing, deleting, pinning, or locking a bulletin/thread. Messages are currently immutable.
- Converting an existing channel into or out of announcement mode.
- An announcement notification preference, top-level-only unread counts, or moderation tools.
- A workspace-wide minimum desktop-version policy. Incapable legacy clients have the deliberately
  degraded behavior defined in [Compatibility, sync, and rollout](#compatibility-sync-and-rollout).

## Channel behavior

`access` remains the visibility rule and is independent from `channelMode`.

| Channel mode | Who may create a root message | Thread replies and reactions | Tasks |
| --- | --- | --- | --- |
| `chat` | Any visible active principal with the existing message scope | Existing behavior | Enabled |
| `announcement` | Active human workspace owner who can see the channel | Any visible active principal with the existing message scope | Disabled |

Both `workspace` and `members` access modes are supported. Existing membership privacy remains
authoritative: a workspace owner who is not a member of a members-only announcement channel does
not gain a read or publishing bypass. Its owner may add another workspace owner through the normal
channel-membership flow when that owner should publish there.

### Publishing rules

For an announcement channel:

1. A message with `threadRootId: null` is a bulletin. The server accepts it only from an active
   human workspace owner who can see the channel.
2. A message with a valid `threadRootId` is a reply. The existing root validation continues to
   require that root to be a top-level message in the same conversation. Any visible, active
   member with ordinary message-write authority may reply.
3. Emoji reactions keep their current visible, non-archived-message authorization. They are
   available on both bulletins and replies.
4. Archiving retains its current meaning: no new bulletin, reply, reaction, or task mutation is
   accepted.

Normal chat channels keep their present behavior. An announcement channel never grants a member
the ability to post a root message, even when an old client still renders a normal composer.

### Creation rules

- Existing active members may continue to create ordinary chat channels as today.
- Only an active human workspace owner may create an announcement channel.
- A members-only announcement channel follows the existing creation behavior: its creator becomes
  a channel owner and can manage its member list.
- `channelMode` is immutable in v1. The create flow is the only way to choose it, and the database
  rejects later changes.

## Desktop experience

Announcement mode should look like a channel type, not a restricted version of a standard chat.
These requirements apply when a desktop advertises `announcement-channels-v1` and the server has
enabled the corresponding feature flag. The intentionally degraded legacy behavior is specified
below rather than silently treated as equivalent.

### Creation

The standard channel-creation flow remains available to active members for **Discussion**
channels. When the creator is an active workspace owner and the feature flag is enabled, that same
flow also offers a **Channel type** choice:

- **Discussion** — everyone with access can post and the channel has Tasks.
- **Announcement** — workspace owners post bulletins; members react or reply in threads; the
  channel has no Tasks.

Selecting Announcement must make the taskless behavior explicit in the choice description. Users
who are not workspace owners receive the usual Discussion-only flow; they do not see a disabled
Announcement option.

### Navigation and header

- Render an announcement/megaphone icon rather than the ordinary `#` channel icon in navigation,
  the quick switcher, and the header. The accessible name identifies it as an announcement channel.
- The header explains the participation rule, for example: “Only workspace owners can post
  bulletins. Reply in a thread or react to an update.”
- Keep the existing access/member control and owner archive control.
- Remove the entire `Chat | Tasks` segmented control. Do not leave a disabled Tasks tab or a lone
  Chat tab.

### Timeline and composers

- Bulletin roots use the normal message presentation, reaction controls, and Reply-in-thread
  action. Reply should remain discoverable on focus as well as hover.
- A member sees a non-focusable notice where the root composer normally appears:

  ```text
  Only workspace owners can post bulletins.
  React to an update or open its thread to reply.
  ```

  A disabled “Message …” textarea is not acceptable because it suggests a temporarily unavailable
  action rather than the channel’s intended purpose.
- A qualifying owner sees the same composer space relabeled for bulletin authoring, such as
  “Write a bulletin…” and “Post bulletin”.
- The existing thread drawer and reply composer remain available to every eligible member.
- An empty announcement channel says that workspace-owner updates will appear there; it does not
  refer to a task board.

### No Tasks means no task surface

For an announcement channel, every capable client user—including its publisher—sees none of the
following:

- the task view, board/list toggle, task drawer, or task-loading request;
- the `+ Task` message hover action;
- task creation, edit, or move controls; or
- channel tasks in My Tasks or task deep links.

If stale local UI state says the selected pane is `tasks`, selecting or refreshing an announcement
channel must reset it to `chat` without a blank/error view.

An incapable legacy client receives no `channelMode` property and can therefore render historical
chat or Tasks chrome. That is an explicitly unsupported, degraded presentation: root sends remain
server-rejected with `403`, task calls remain server-rejected with `404`, and no implementation may
use that legacy UI as evidence that announcement tasks are available.

## Domain model and contracts

Persist `channelMode` as an immutable, channel-only property:

```ts
type ChannelMode = "chat" | "announcement";
```

It is separate from `Conversation.kind` and `ChannelAccess`:

- `Conversation.kind` continues to distinguish channel and direct-message storage/routing.
- `access` continues to determine who may see a channel.
- `channelMode` determines the coupled v1 behavior above: root-message publisher policy and task
  availability.

There is intentionally no user-configurable `tasksEnabled` or posting-policy matrix in v1. The
mode is the canonical persisted policy: `chat` means member roots plus tasks; `announcement` means
workspace-owner roots plus no tasks. If a future product needs other combinations, introduce
separate policy fields through a new migration rather than overloading this mode.

### Schema changes

- Add `channelModeSchema` to `packages/contracts`.
- Add nullable `channelMode` to `conversationSchema`: canonical channel records send `chat` or
  `announcement`; canonical direct conversations send `null`. At the legacy wire/cache boundary,
  an omitted value normalizes to `chat` only for a channel and to `null` only for a non-channel.
  Explicit kind/mode mismatches remain invalid.
- Add optional `channelMode` to channel creation input. Omission defaults to `chat`. Even a
  capable desktop omits it for a Discussion channel, so ordinary channel creation remains safe
  against a pre-feature server with a strict create schema; only an announcement request sends
  `channelMode: "announcement"`.
- Include it in every capable conversation projection: summaries, channel/direct creation and
  archive responses, encrypted cache records, and `channel.created`, `channel.archived`, and
  `direct_conversation.created` projections.
- Keep the existing message, reaction, and thread schemas unchanged. A bulletin is identified by
  its channel mode and `threadRootId: null`, not by a second message type.

The database migration should be a new forward-only `0016_announcement_channels.sql` migration.
It must be safe while a pre-feature server binary is still writing conversations:

1. Add nullable `conversations.channel_mode text` with **no column default**, backfill every
   channel (archived or active) to `chat`, and leave every non-channel conversation `NULL`.
2. Add a `BEFORE INSERT` trigger that normalizes an omitted/`NULL` mode to `chat` only when
   `kind = 'channel'`. This lets an older server that omits the new column continue creating both
   channels and direct conversations during rollout.
3. Add a NULL-safe database constraint equivalent to:

   ```sql
   (kind = 'channel' AND channel_mode IS NOT NULL
      AND channel_mode IN ('chat', 'announcement'))
   OR
   (kind <> 'channel' AND channel_mode IS NULL)
   ```

   A nullable `CHECK` alone is not sufficient because SQL `UNKNOWN` passes a check constraint.
4. After backfill, add a `BEFORE UPDATE OF channel_mode` trigger that rejects changes where the
   values are `IS DISTINCT FROM` one another.

Earlier migrations must not be edited. Migration tests cover old-server-shaped inserts that omit
the column for both a channel and a direct conversation.

## Server authorization and task enforcement

The server is the authority for these rules. The renderer only reflects the result.

### Messages and reactions

For a new message or reaction mutation, authorization comes from locked database state, never the
role captured in the request identity alone. Implement one authorization helper with this lock
order: workspace, actor workspace membership, conversation, then the actor's active private-channel
membership or grant when one is relevant. Archive, workspace-role/status change, and private-channel
membership removal paths must acquire the applicable prefix in the same order. This closes the
archive/removal/demotion race rather than merely rechecking a stale identity.

The helper preserves the existing non-disclosing error order: a hidden private channel or archived
channel fails its current visibility/writability check before announcement authorization. Only an
otherwise visible, active member who lacks owner status receives the stable bulletin `403`; a
private non-member must not learn that the announcement channel exists.

`WorkspaceRepository.sendMessage` uses that helper for every new message. `createChannel` uses the
workspace/membership portion before inserting an announcement channel. The reaction path retains
its existing message-target locking, but must likewise recheck active membership before accepting a
new reaction mutation.

- After the per-client-message advisory lock, a matching stored message with the same fingerprint
  returns its canonical idempotent response without creating a second message, even if the sender
  later loses access. A reused ID with a different fingerprint remains `409 CONFLICT`.
- For a new root in announcement mode, return `403 FORBIDDEN` with the stable message “Only
  workspace owners can post bulletins.” unless the authoritative principal is an active human
  workspace owner who can currently see the channel.
- For an announcement reply, retain the current same-conversation/root-only validation and normal
  message-scope checks after the active-membership recheck.
- Creation of an announcement channel, a bulletin root, archive, and membership/role revocation
  each have concurrent-operation tests that prove the shared lock discipline.

### Tasks

Every task endpoint that targets an announcement channel must treat it as unavailable, not merely
hide it in the desktop. Return the existing `404 NOT_FOUND` category with “Tasks are not available
in this channel”, consistent with unsupported conversation task targets. `GET /tasks/mine` instead
filters out tasks from disabled channels; it must not fail the member's unrelated personal list.

The policy applies to all of these paths:

- conversation-ID list and create;
- channel-slug list and create;
- task lookup, edit, and move;
- My Tasks filtering;
- task bot read/write calls, including task-number lookup; and
- bot channel configuration and grant CLI calls. A bot configuration targeting an announcement
  channel cannot be created, and a bot cannot receive an unusable announcement-channel grant.

`#requireTaskConversation` becomes the central write guard. Read/list paths that do not currently
pass through it must explicitly resolve and reject disabled channels, including channel-task lists,
task-number lookup, and task-ID lookup before it can expose a task. `GET /tasks/mine` filters by
`channel_mode IS DISTINCT FROM 'announcement'`.

The database provides defense in depth: a task `BEFORE INSERT OR UPDATE OF conversation_id` trigger
rejects an announcement conversation. Public routes still return the specified `404`, rather than
leaking a database error. No task row can be created for a new announcement channel, so it
contributes no task events or cache state.

## Compatibility, sync, and rollout

Conversation and event schemas are strict. Sending an unknown `channelMode` property to an older
desktop can break bootstrap, conversation pagination, cached snapshots, or conversation events.
This is a compatibility feature, not a server-only migration. A client capability controls wire
shape and UI availability; it never grants publishing authority.

1. Add an `announcement-channels-v1` capability. A desktop advertises it only when it also
   supports the existing thread-reply capability.
2. Add `featureFlags.announcementChannels` to the capable bootstrap contract. A capable desktop
   treats an absent flag as `false` and offers announcement creation only when it is `true`. The
   server sends this flag only to a client that advertises `announcement-channels-v1`. It is a
   one-way availability contract in v1: after it becomes true, it remains true whenever
   announcement-channel data can exist. An emergency creation freeze uses a separate server gate;
   it must not make persisted announcement channels render as ordinary chat.
3. A capable desktop advertises the capability on every request that can create or return a
   conversation: bootstrap, listings/pagination, channel creation, direct-conversation creation,
   archive or other mutation routes returning a conversation, history, sync, and realtime-ticket
   requests.
4. The server includes `channelMode` only in capable projections, and strips only that property
   from legacy projections. This covers every conversation-bearing response and event, including
   channel/direct creation and archive responses plus `channel.created`, `channel.archived`, and
   `direct_conversation.created`. Canonical durable events remain complete after cutover; delivery
   projection is selected from the recipient capability.
5. Realtime tickets persist an `announcementChannels` capability flag. Ticket issuance, ticket
   consumption, the realtime principal, and `syncPrincipal` all carry it, because a WebSocket
   replay has no request header from which to reconstruct the projection choice.
6. When a desktop first gains `announcement-channels-v1` for a cached workspace, it stops its old
   realtime session, obtains a new capable ticket, invalidates its prior conversation
   snapshot/cursor, and replaces it from a complete capable bootstrap before applying incremental
   sync. A legacy-projected event may already have advanced the durable cursor without the immutable
   mode field, so cursor replay alone is insufficient.
7. The server accepts `channelMode: "announcement"` only when the feature flag is enabled, the
   request advertises `announcement-channels-v1`, and the requester passes the active-human-owner
   authorization check. An incapable client cannot create an announcement channel.
8. Incapable legacy clients are deliberately degraded rather than silently considered feature
   complete. They receive the legacy-shaped projection and may render ordinary channel or task
   chrome; root sends and task calls remain authoritatively rejected as specified above. The first
   capable-client experience provides the promised thread reply and taskless UI. A universal
   desktop upgrade is not required in v1.
9. Roll out in this order: run the safe schema migration; deploy the compatible server and
   realtime workers with `featureFlags.announcementChannels` disabled; drain and verify every
   pre-feature server/realtime worker; release the capable desktop; then enable the feature flag.
   No announcement channel may be created, and no durable conversation event may carry
   `channelMode`, until every serving worker can parse and project the canonical event. An old node
   would otherwise be able to bypass root/task enforcement or fail on a new strict event. Enabling
   the process flag atomically persists a one-way workspace cutover. Every compatible node reads
   that database state before publishing a conversation event, so a node still carrying the old
   local setting cannot strip `channelMode` after announcement data can exist. Disabling creation
   in an emergency requires a separate future gate and never reverses this durable cutover.

Mode immutability avoids a `channel.updated` event, task-cache purge, and historical-task policy in
the first release. A later mode toggle must introduce all three deliberately.

## Acceptance criteria

### Contracts and database

- A capable client normalizes an omitted legacy mode to `chat` for a channel and `null` for a
  non-channel; direct conversations cannot carry a non-null channel mode.
- Invalid/unknown modes and invalid kind/mode combinations are rejected.
- The migration backfills every existing channel to `chat` without modifying prior migration files,
  accepts old-server-shaped channel and direct inserts, and enforces the NULL-safe kind/mode
  invariant thereafter.
- An updated desktop can create an ordinary Discussion channel against a pre-feature strict server
  by omitting `channelMode`.
- A database-level update attempt cannot change `channel_mode` after creation.
- A task insert or conversation reassignment cannot target an announcement channel.

### Authorization and API

- A member can create/send in an ordinary chat channel as before.
- A human workspace owner using a capable client while the feature flag is enabled can create an
  announcement channel and post a root bulletin.
- A member cannot create an announcement channel or post a root bulletin, including through a
  direct API request or a stale client.
- A visible member can reply to a bulletin and add/remove reactions on bulletins and replies.
- An agent with ordinary `messages:write` cannot publish an announcement root; a bot cannot reach
  message routes.
- Members-only visibility remains intact; a non-member gets no channel/read/publish bypass.
- A hidden private channel and an archived channel retain their existing non-disclosing status;
  only a visible active non-owner receives the bulletin-specific `403`.
- New message/reaction authorization, archive, membership removal, and owner authorization use the
  common locked, authoritative-membership discipline; race tests cover archive, removal, and owner
  demotion against a send.
- A matching idempotent message retry returns its original canonical result after later archive or
  access loss; a mismatched fingerprint remains a conflict.
- Every task route/read path and task bot path rejects an announcement channel, My Tasks excludes
  it, and bot channel creation/grants reject it before creating unusable configuration.
- Accepted and rejected announcement-channel creation/root attempts emit audit-safe operational
  records with actor, workspace, operation, and correlation identifiers, plus a target conversation
  identifier when one exists, but no message body.

### Compatibility, sync, and rollout

- A capable bootstrap receives both the capability-gated feature flag and `channelMode`; literal
  legacy response/event JSON omits the property on every conversation-bearing surface.
- Realtime ticket persistence, realtime-principal authorization, direct sync, and WebSocket replay
  all preserve the announcement capability used for event projection.
- A newly capable cached desktop replaces its workspace snapshot before cursor sync, preventing a
  legacy cursor from permanently classifying an announcement channel as `chat`; it stops the old
  socket and obtains a new capable ticket first.
- Concurrent capable and legacy sessions for the same user receive their respective projections by
  request/ticket, rather than by user identity or the stored durable event alone.
- An announcement-creation request without the capability or with the feature flag disabled is not
  accepted as announcement mode.
- Feature enablement occurs only after every serving server and realtime worker supports the new
  canonical event and authorization rules; a deployment test proves no old node remains.
- Capability negotiation never expands authorization: an incapable client, agent, bot, or service
  credential cannot gain bulletin publication by omitting or claiming a capability.

### Desktop and evidence

- On a capable client with the feature enabled, an announcement channel has the announcement
  icon/label, explanatory header, no Tasks toggle, no task fetch, and no `+ Task` action.
- A member sees the bulletin notice, can react, open a root thread, and send a reply.
- A workspace owner sees the differentiated bulletin composer and can post a root.
- Pane state recovers to Chat when an announcement channel is selected.
- An incapable legacy desktop follows the documented degraded projection and cannot create an
  announcement channel; it is not used to validate announcement UI behavior.
- Capture reusable screenshots under `docs/screenshots/` for the member timeline/notice and hover
  controls, thread reply, and owner bulletin composer before a pull request is considered complete.

## Deferred follow-ups

- Auditable service publishers and per-channel publisher grants.
- A true workspace administrator role, only after its effects on invites and existing owner-only
  operations are designed.
- Thread locks, moderation/removal, and bulletin correction/retraction behavior.
- Member notification preferences and a top-level-bulletin-specific unread signal.
- An explicit conversion/export flow for existing channels with task data.
