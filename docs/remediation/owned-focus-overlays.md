# Focus and overlays

Each App owns one `OverlayOwnership` instance, shared with its portals. Search, the conversation
switcher, channel creation, people, task details and theme-discard confirmation acquire a lease
while open. The top lease handles Escape and modal Tab wrapping. The channel-creation popover
keeps its existing nonmodal Tab behavior. Claude's inline permission request remains an inline
alert; it does not acquire modal focus.

The lease captures the opener and restores it after React removes the overlay. A successful
search or switcher selection opts out of restoration so the workspace can focus its destination.
Removing a covered overlay cannot steal focus; child return targets are repaired if their parent
is removed first. A newer overlay or a user focus choice cancels deferred restoration. Closing and
unmounting release the same lease once. Compact chrome keeps its separate open/close notification,
paired with the callback that acquired its pin even if callback identity changes while open.

`useComposerFocus` owns a typed conversation or thread intent, its target and its recording time.
Navigation records an intent. An unavailable composer, a hidden workspace or an owned overlay
blocks delivery. The intent expires after fifteen seconds or when the user chooses focus. A reply
navigation preserves its thread intent while returning from another page, including when the root
arrives later. An enabled composer consumes the intent only after focus reaches it.

App supplies the selected conversation, thread and availability. It no longer queries the document
for `aria-modal`. Preferences consults the same owner before handling Escape. Dialog accessibility
attributes describe the UI; they are not a registration mechanism.
