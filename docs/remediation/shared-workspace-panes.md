# Workspace panes and test fixtures

`WorkspaceRuntime` accepts `WorkspaceClient`, which contains workspace data, replica crypto and
realtime operations. Session authentication, application updates, preferences, notifications and
Claude remain at the App composition boundary. The runtime test client implements this smaller
interface and no longer supplies unrelated desktop services.

`useMessagePane` owns one list's scroll position, live-tail status, read visibility memory and
scheduled read callback. Entering a conversation uses its unread divider. A thread opens at its
latest reply and follows newly queued replies. Incoming messages respect a reader who has scrolled
away. Replacing a conversation or disposing a pane cancels its scheduled callback. Interactive
visibility and focus checks remain required; headless clients never mark messages read.

`MessageTimeline` renders ordered message and outbox rows. `WorkspaceMessageRow` supplies the shared
message actions. Conversation callers supply task creation, unread markers and thread reply counts.
Thread callers supply a separate DOM prefix and leave those conversation actions absent. The thread
root remains outside the reply list, so the first reply never groups with its root. A collection that
has not loaded shows a loading or failure notice instead of the empty-conversation welcome.

`useMessageComposer` gives each pane its own draft collection, failed-send editing state and error
state. Conversation drafts use conversation IDs; thread drafts use root IDs. Both use the existing
compare-before-clear rule, which retains text edited while an earlier submission is pending.
Attachment reservations and session cancellation stay in App; focus ownership follows in item 21.

`createAppClient` supplies the common App startup behavior with a complete desktop contract. Feature
tests override only the operations they exercise, using ordinary checked function types. Unsupported
operations record their names and throw; the fixture also checks that record after the test so a
product error handler cannot hide an unexpected call. `createAppRuntimes` constructs actual preference
runtimes instead of casting object literals to classes with private fields.
