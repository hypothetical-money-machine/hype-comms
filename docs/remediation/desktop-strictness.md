# Desktop strictness

Desktop main, preload, shared types, renderer and integration tests now inherit
`exactOptionalPropertyTypes` and `verbatimModuleSyntax` from the shared compiler policy.
There are no desktop overrides for either option.

Optional React props that are forwarded as undefined retain that meaning explicitly in their
component types. Internal cancellation options also accept an absent signal. Domain objects,
IPC arguments, cookie fixtures and cache metadata omit properties with no value instead of
widening wire or persisted-data types. Message snapshot writes preserve an existing reaction
position when appropriate and omit a cleared position.

Device-preference patches are parsed into a complete state before the controller's existing
canonicalization. This keeps the same validation behavior while making the merged result's
type explicit. Renderer preference fixtures validate their complete state too.

The compiler changes do not change stored versions, protocol shapes, input defaults, Claude's
provider policy or platform notification behavior. Existing cache/runtime conformance and
interaction suites remain the behavior checks. UI evidence is captured from the running Electron
app because this change includes renderer source, even though the component edits are type-only.
