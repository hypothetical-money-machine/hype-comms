# Native notifications

Native notifications are implemented behind a build flag and a device-local preference. Milestones
0 through 3 are covered by deterministic and headless tests. The signed and notarized macOS
release build includes the controller, but the device preference remains off by default. Windows and
Linux release builds compile notification presentation out. Milestone 4, installed native evidence,
is still open for every supported platform.

One signed macOS ARM64 run has captured a synthetic OS toast and restored Hype Comms after its
click. Those captures prove one part of the macOS lane. They do not complete the macOS, Windows, or
Linux lane. Tracking remains in [issue #42](https://github.com/hype-comms/hype-comms/issues/42).

## Behavior

`HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED` is a build-time setting. `0` or an unset value omits
notification presentation. `1` includes the controller. An enabled build still starts with
notifications and message previews disabled for every device.

The controller evaluates only live `message.created` events from the current signed-in scope. It
can notify for a verified mention, a direct message, or a recipient-specific participated-thread
reply. A message produces at most one notification per running device.

| Event or state | Behavior |
| --- | --- |
| Direct message | Notify when eligible |
| Verified mention | Notify when eligible |
| Participated-thread reply | Notify when eligible |
| Ordinary channel message, reaction, task, membership, read, or system event | Do not notify |
| Self-authored, duplicate, startup, HTTP catch-up, or pre-live replayed message | Do not notify |
| Focused app or visible live-tail message | Do not notify |
| Selected conversation scrolled away from the tail | Notify when otherwise eligible |
| Disabled, unsupported, denied, signed-out, or replaced session | Do not notify |

Verified mention takes precedence over DM and participated-thread reasons. Scope, freshness,
focus, visibility, capability, and duplicate checks take precedence over the reason.

The controller arms only after the current realtime connection receives `system.connected`.
Events before that boundary repair the replica but do not notify. Its deduplication watermark is
session-local notification bookkeeping; it never advances the sync cursor, read cursor, unread
count, or encrypted replica.

Notification text contains the author and conversation by default. Message-body preview is a
separate device preference. Message bodies, labels, and action targets must not appear in logs,
metrics, or the headless capture artifact.

## Click handling

Electron main owns notification eligibility and native presentation. The renderer reports bounded
activity state and performs normal conversation navigation. It cannot request arbitrary title,
body, or click targets.

A click action identifies the current session generation, user, workspace, conversation, message,
and optional thread root. Main derives those fields from the accepted event. On click, it restores
the window, checks the current scope, fetches an authorized missing message when necessary, and
opens the exact conversation or thread. A signed-out, changed, or unauthorized scope discards the
action.

Main retains an action until the current renderer acknowledges navigation. The action is
memory-only. Sign-out, scope replacement, membership removal, and shutdown purge relevant
actions and close live notifications.

On macOS, an enabled process can observe notifications after its last window closes. The observer
does not deliver renderer events or advance the renderer cursor. A recreated window catches up from
its encrypted replica, loads the authoritative snapshot, completes HTTP sync, and then starts a
fresh realtime connection. Windows and Linux quit after their last window closes.

## Headless capture

`npm run demo:headless` enables the controller in an isolated development build and uses a
capture presenter, never Electron's native presenter. It writes private mode-`0600`
`notifications-<profile>.jsonl` files. Each record contains only a version, opaque capture ID,
and eligibility reason.

Automation activates a capture through the headless-only IPC bridge while its in-memory callback is
live. Editing the JSONL file cannot create an action. Packaged and non-headless builds cannot use
this bridge.

## Evidence and rollout

The policy, controller, realtime, renderer recovery, IPC, Windows application identity, and
headless interaction tests run in the repository. The checked-in renderer and headless screenshots
show settings, click-through, bootstrap recovery, participated-thread replies, and mention
precedence. They do not show installed operating-system notification behavior.

The packaged lane for a platform must cover its full row in the
[supported host matrix](architecture.md#supported-host-matrix): installation, launch, notification
permission where observable, enabled and disabled states, focused and minimized behavior, display,
attribution, click-through, sign-out, update teardown, restart, and uninstall. Package smoke only
checks package contents.

The macOS opt-in evidence lane builds a signed and notarized synthetic-only artifact, records an
OS toast, activates it, and captures the restored application. Its existing ARM64 evidence is
[the toast](screenshots/macos-native-notification-toast.png) and
[the restored window](screenshots/macos-native-notification-click-through.png). Windows needs
installed NSIS attribution and click evidence. Linux needs installed desktop-integration and click
evidence.

Enable the build flag only on the individual release-platform job that has passed its installed
lane. The setting applies to every artifact built by that job. Do not set it globally across the
release workflow.

Rebuilding a platform with `HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED=0` removes native
presentation without changing server state, unread state, sync, cached data, the outbox, or device
preferences. Presenter errors are local capability failures; they do not reconnect realtime, replay
messages, or change server state.

## Not included

The current implementation does not send notifications after the desktop process has fully quit. It
does not include push, email, browser, or mobile delivery; ordinary channel alerts; per-channel
preferences; summaries or batching; schedules; custom sounds; inline replies; action buttons; tray
badges; or notifications for tasks, reactions, membership, updates, or operations.
