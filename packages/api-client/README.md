# Shared workspace client

Desktop main and the CLI use this package for protocol-2 HTTP and realtime operations.
`workspaceEndpoints` defines paths and request/response schemas from `@hype-comms/contracts`.
Callers supply credentials, fetch, socket creation, cancellation and error presentation. The
renderer continues to use validated IPC and receives no credentials or network access.

`HttpClient` bounds JSON bodies to 4 MiB, checks successful response content types, rejects
redirects and unsupported protocol majors, and validates successful responses. Error responses
retain their HTTP status even when an intermediary returns HTML. `ApiClientError.kind` distinguishes
request, network, contract, redirect and HTTP failures. `WorkspaceProtocolError` identifies a
required coordinated upgrade. Idempotent retries are opt-in and require the original key.

`AttachmentClient` uses a separate bounded binary path. Downloads require an identity encoding,
a valid length and SHA-256 digest, and stay within the 25 MiB attachment limit. Desktop owns the
bounded local-file read, session guards and filename presentation. The CLI owns safe output-path
creation and process exit codes.

`WorkspaceRealtimeClient` owns ticketing, frame validation, scope binding, buffering, reconnect
and acknowledgement. Its socket implementation is injected through `RealtimeSocket`. Desktop
provides native notification observation and IPC delivery; CLI provides serialized output.
Parsing or delivering a frame does not advance the resume position. Desktop acknowledges after
cache commit. CLI acknowledges after the writable completes the output line.

Replay before the identity handshake and durable events waiting for consumer acknowledgement
are each limited to 1,024 events and 4 MiB. Individual frames are limited to 4 MiB. Overflow stops
the connection and requests bootstrap. Unknown product events are incompatible with the single
supported canonical protocol; they are never skipped while acknowledging later positions.

Run `npm test --workspace @hype-comms/api-client` for package tests. The full repository check
also runs the desktop and CLI consumers, including a real WebSocket test that holds output at
sequence 6 and proves reconnect still starts at sequence 5 until that output completes.
