# Hype Comms Context

## Tooling notes

### Running `agy` (Google Antigravity CLI) headlessly in YOLO mode

There is no `--yolo` flag. The equivalent unattended combination is:

```bash
agy --mode=accept-edits --dangerously-skip-permissions -p "your prompt here"
```

- `--mode=accept-edits` auto-approves file edits.
- `--dangerously-skip-permissions` auto-approves all tool calls, including shell commands.
- `-p` / `--print` / `--prompt` runs one prompt and exits (headless one-shot).

For isolated CI/sandbox use, the [shelajev/agy-sbx-kit](https://github.com/shelajev/agy-sbx-kit) Docker Sandboxes kit sets exactly these flags and handles headless OAuth.

## Resolved: renderer screenshot evidence for #47

The member-profile-titles feature is implemented and its renderer screenshot evidence is captured. The headless demo smoke (`npm run test:demo:headless`) passes on macOS in both flows (direct-message and participated-thread). Getting there took four fixes:

1. `scripts/demo-environment.mjs` now appends the Electron stability flags below and honors `HYPE_COMMS_DEMO_API_PORT` (the default port 3000 can collide with other local dev servers).
2. `confirmDeepLinkSignIn()` in `apps/desktop/src/main/index.ts` returns `true` without the modal when `headlessDesktopConfiguration !== null`; the modal has no user to click it in headless mode.
3. `scripts/demo-headless-local-smoke.mjs` keeps draining launcher stdout after the readiness record; the demo API logs every request, and an undrained pipe eventually blocks the demo children mid-smoke.
4. Root cause of the final stall: `PersistentWorkspaceCache.upsertHistory` awaited the decryption IPC round-trip inside a Dexie transaction. Chromium's IndexedDB marks the transaction inactive during that await, the follow-up `bulkPut` failed, and notification click-through silently never set `focusedMessageId`. Fixed by hoisting `bulkGet`/`decryptRows` out of the transaction. This bug also affected human notification click-through, not just the smoke.

## Research findings: headless Electron GPU/network crash

Driven via `agy` (Google Antigravity CLI) on 2026-08-23.

### Root causes (priority order)

1. **Docker default `/dev/shm` size (64MB)** — Chromium/Electron uses POSIX shared memory for IPC, pixel buffers, and network streaming. Exhaustion causes `SIGBUS` or silent termination.
2. **Container seccomp / sandbox restrictions** — Electron's GPU helper (`--type=gpu-process`) and Network Service utility process fail without `CAP_SYS_ADMIN` or SUID sandbox helpers.
3. **Missing virtual display** — Electron `BrowserWindow` needs X11/Wayland; without `Xvfb` the GPU/software rasterizer exits immediately.
4. **Missing Mesa/software GL libraries** — SwiftShader/llvmpipe fallback segfaults if `libgbm1`, `libgl1-mesa-dri`, `libegl1` are absent.
5. **Repeated GPU crash threshold** — Chromium disables GPU after ~3 crashes and kills the child process; renderer never reaches the readiness marker.

### Recommended Electron flags

```text
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
--disable-gpu
--disable-software-rasterizer
--enable-features=NetworkServiceInProcess
--disable-features=IsolateOrigins,site-per-process
```

### Recommended environment variables

```text
DISPLAY=:99
ELECTRON_ENABLE_LOGGING=1
ELECTRON_ENABLE_STACK_DUMPING=1
ELECTRON_DISABLE_SANDBOX=1
```

### Local code gap

`scripts/demo-environment.mjs` functions `headlessElectronArguments()` and `headlessElectronViteArguments()` previously set only CDP/remote-debugging flags. They now append the stability flags above, and the headless desktop environment sets `ELECTRON_ENABLE_LOGGING=1` and `ELECTRON_ENABLE_STACK_DUMPING=1`. On macOS the headless demo runs without Xvfb; the display-related findings apply to the Linux sandbox/CI case.
