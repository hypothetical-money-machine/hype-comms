# Preference persistence and state

`JsonPreferenceFile` owns bounded JSON reads and serialized atomic writes for the five non-secret
preference files. Each store supplies its path, byte limit, default and codec. Existing filenames
and stored versions remain unchanged, including the theme version-1 read migration. Authentication,
credentials and strict private-file reads retain their separate requirements.

A save captures its encoded bytes before joining the write queue. The existing atomic writer keeps
private permissions, file synchronization, rename and best-effort directory synchronization. Failed
writes do not poison later requests. A value that exceeds the read limit is rejected before it can
replace the last durable value. Each settings file still has one application-wide store owner;
creating multiple writers for the same path is not supported.

`PersistedPreference` owns initialization, serialization and publication for compact mode and
device preferences. Partial device updates merge with the most recently committed value. Accepted
writes drain during disposal and update that value for later queued patches, while disposed
controllers reject completion and publish no notifications. These rules preserve the existing
shutdown behavior.

Theme retains its OS event subscription, appearance resolution and rollback. Notification settings
retain capability refresh and restrictive-intent handling. An opt-out takes effect immediately;
expanding permission waits for its file write. Both paths now isolate listener and error-reporter
failures, so a broken renderer cannot prevent an opt-out from reaching disk or block later listeners.
The Claude controller uses the same notification helper and continues to omit listener payloads
from diagnostics.

Existing controller and real-file tests cover initialization retries, queue ordering, failure,
disposal, schema migration and permissions. New regressions cover oversized Unicode writes,
caller mutation of queued values, listener failures before and after notification persistence,
and loading the durable opt-out in a restarted controller.
