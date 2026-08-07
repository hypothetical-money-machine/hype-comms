# Security policy

Do not open a public issue for suspected vulnerabilities. Report them privately to a
repository administrator with reproduction steps, affected versions, and any known impact.
Do not include production credentials or real message content in the report.

Hype Comms ships only supported Electron and Node.js release lines. Renderer sandboxing,
context isolation, a restrictive Content Security Policy, narrow validated IPC, signed
artifacts, and authenticated workspace-scoped server access are release invariants.
Security-sensitive changes must preserve these invariants and update the relevant source,
strict contracts, and regression tests together.
