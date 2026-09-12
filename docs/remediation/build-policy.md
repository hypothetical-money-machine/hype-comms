# Compiler policy and dependency builds

All workspaces inherit strictness from `tsconfig.base.json`. Node packages also inherit the
NodeNext, ES2024 and emit defaults in `tsconfig.node.json`. Desktop keeps its ES2022 Bundler
resolution, explicit Node or DOM libraries, JSX settings and no-emit compilation. Desktop's
optional-property and module-syntax checks remain explicit exceptions for the next focused PR.

Contracts, API client and server form the emitting project graph in `tsconfig.build.json`.
API client references contracts; server references contracts. CLI and both desktop compiler
projects reference their shared dependencies. Their standalone commands build dependencies with
`tsc -b`, which skips unchanged projects. There are no npm pre-hooks rebuilding contracts indirectly.

CLI is a no-emit compiler project. Its build metadata remains beside its configuration, while
esbuild replaces `dist` with self-contained command and download-worker bundles. Desktop still
builds through electron-vite. Server copies migrations and release notes after its compiler build.
Root builds run the shared graph before these asset and bundle steps. Typechecking emitting
projects also prepares their declarations, so it cannot leave a no-emit build record that suppresses
needed JavaScript on the next build.

For a clean compiler build, use `tsc -b tsconfig.build.json --clean` before the root build. Remove
workspace build metadata as well as output directories when manually clearing generated files.
Do not run independent builds against the same checkout concurrently; they share generated outputs.

Zod remains a normal dependency in each consuming workspace. `npm run verify:zod-alignment`,
part of the full check, requires the contracts pin in every first-party consumer and verifies
lockfile resolution, including nearer workspace installations. It permits unrelated transitive
Zod versions. IPC error handling must not depend on an error object preserving its prototype
between processes.
