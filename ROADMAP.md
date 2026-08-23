# Hype Comms roadmap

This file records the product's current status and the next visible work. Individual work items
live in [GitHub Issues](https://github.com/hypothetical-money-machine/hype-comms/issues).

## Available now

- Invite-only human access through email magic links and optional WorkOS AuthKit, with rotating
  device sessions and local revocation.
- PostgreSQL-backed channels, 1:1 DMs, members-only channels, threads, reactions, verified
  mentions, unread state, search, and reconnecting sync.
- Channel and personal task boards with assignments, priorities, due dates, links to messages, and
  a My Tasks view.
- Scoped agents and task-only bots with owner-issued tokens, explicit channel grants, rotation, and
  revocation.
- Encrypted IndexedDB cache and outbox with idempotent message sends.
- Local file attachments in channels, DMs, and threads, with conversation Files views.
- Five-minute author-only message retraction and owner-only metadata Communication paths.
- macOS opt-in native-notification code behind disabled-by-default build and device settings.

The SQLite prototype and shared access code are retired.

## Current work

- Use the app for day-to-day communication and fix the failures that interrupt that use.
- Finish attachment hardening: quarantine, malware scanning, hosted storage, expiring downloads,
  and filename search.
- Collect the installed native-notification evidence required for each supported platform. macOS
  has one signed ARM64 toast-and-click run; the full macOS, Windows, and Linux lanes remain open.
- Configure Azure Trusted Signing for Windows and add Linux release signatures, SBOMs, and
  provenance checks.
- Record externally verifiable backup, restore, and production-operations evidence in the
  deployment repository.

## Later

Potential future work includes multiple workspaces, group DMs, message editing beyond the
retraction window, presence, typing indicators, browser and mobile clients, richer agent
capabilities, and hosted storage. These are not part of the current product contract.

## Invariants

PostgreSQL remains authoritative. Realtime is repaired through HTTP sync. Sends remain idempotent.
The server authorizes every query. The renderer never receives product credentials.
