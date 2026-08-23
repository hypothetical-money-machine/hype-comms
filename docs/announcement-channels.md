# Announcement channels

Announcement channels are implemented behind `HYPE_COMMS_ANNOUNCEMENT_CHANNELS_ENABLED`, which
defaults to `false`. The database migration, contracts, server authorization, capability
negotiation, and desktop UI are in the repository. With the gate off, clients cannot create an
announcement channel and do not receive its feature flag.

When the gate is on, capable desktop clients advertise `announcement-channels-v1`. The server
records the workspace's availability and projects `channelMode` only to capable clients. Older
clients retain the older conversation shape. Capability negotiation affects the response shape and
UI; it does not grant authority.

## Channel rules

`channelMode` is an immutable channel property. It is independent from the channel's visibility
setting.

| Channel mode | Root messages | Replies and reactions | Tasks |
| --- | --- | --- | --- |
| `chat` | Any visible active principal with the normal message scope | Normal behavior | Available |
| `announcement` | Active human workspace owners who can see the channel | Any visible active principal with the normal message scope | Unavailable |

Both workspace-visible and members-only announcement channels are supported. A workspace owner
does not bypass members-only channel membership. Agents cannot publish announcement roots. Bots
cannot use message routes. Archived channels reject new messages, reactions, and task changes.

A root message in an announcement channel is a bulletin. Replies use the existing one-level thread
rules. A reply to a reply points to the original root. A non-owner root request receives the same
server-enforced `403 FORBIDDEN` response whether it comes from the desktop, CLI, or a stale client.

Tasks are unavailable for an announcement channel on every task route. The server returns the
existing `404 NOT_FOUND` category, My Tasks excludes these channels, and bot channel grants cannot
target them.

## Desktop behavior

An enabled capable desktop labels the channel as an announcement channel and uses the announcement
icon in navigation and the header. It removes the Chat/Tasks control and never loads channel tasks.

Members see a root-composer notice explaining that workspace owners post bulletins and members can
react or reply in a thread. Qualifying owners see a bulletin composer. The normal thread drawer and
reply composer remain available to every member who can see the channel. If cached UI state selected
Tasks, opening an announcement channel resets the pane to Chat.

## Rollout

Before enabling `HYPE_COMMS_ANNOUNCEMENT_CHANNELS_ENABLED`, deploy the migration and
announcement-compatible server and realtime workers everywhere. The server persists availability
once the gate is enabled, so a worker that does not understand announcement conversations must not
remain in service.

The first capable client replaces its cached conversation snapshot before it applies incremental
sync. This prevents an old, capability-stripped event cursor from classifying an announcement
channel as ordinary chat.

The implementation has tests for channel-mode validation and immutability, root-message
authorization, task rejection, capable and legacy projections, cache replacement, and concurrent
archive, membership, and owner-role changes.

## Not included

Announcement channels do not add a workspace administrator role, service-authored bulletins,
message editing, bulletin retraction, pinning, thread locking, moderation tools, a mode-conversion
flow, notification preferences, or announcement-specific unread counts.
