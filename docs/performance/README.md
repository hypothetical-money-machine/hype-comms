# Performance measurement

[PR split verification](publication-validation.md) records branch checks, fresh native smoke results and their limits.

Make a busy Hype Comms workspace feel as fast as a small one. The [baseline](evidence-2026-09-06.tar.gz) (`docs/performance/baseline-2026-09-06.md` in the archive) sets initial budgets; [retained results](evidence-2026-09-06.tar.gz) (`docs/performance/results-2026-09-06.md` in the archive) records measured gains and remaining work.

Original JSON samples, investigation reports and screenshots are preserved byte-for-byte in [the evidence archive](evidence-2026-09-06.tar.gz). Extract it into a temporary directory to browse the original `docs/performance/README.md` and relative links. [SHA-256 hashes](evidence-sha256.json) identify every original report and result. The archive includes failed and rejected experiments for diagnosis; only complete runs support comparisons.

```sh
mkdir -p /tmp/hype-performance-evidence
tar -xzf docs/performance/evidence-2026-09-06.tar.gz -C /tmp/hype-performance-evidence
```

## Repeat a scenario

Use Node 24.18.x, npm 11.16.x, `npm ci`, and PostgreSQL 17 binaries. On the reference Mac,
PostgreSQL was installed with `brew install postgresql@17`; no Homebrew service was started.
Set `PERF_PG_BIN` to the PostgreSQL binary directory if it differs from
`/opt/homebrew/opt/postgresql@17/bin`. These measurements and process accounting are validated on
macOS arm64 only.

Run scenarios sequentially with other builds and benchmarks stopped:

```sh
npm run perf:baseline -- --label=small --channels=5
npm run perf:baseline -- --label=medium --channels=50
npm run perf:baseline -- --label=large --channels=200
npm run perf:baseline -- --label=medium-delay40 --channels=50 --delay=40
```

Defaults are 200 additional messages per channel, three measured fresh starts, three measured
restored starts, and 20 samples per repeated interaction. Use `--samples=5` and `--iterations=50`
for a follow-up comparison. All scenarios first discard one full desktop startup; every repeated
interaction also discards one warmup. The discarded desktop startup warms the automation driver,
binaries, and database. A measured fresh start still has a new process and an empty desktop profile.

Use `--restore-cache=all` to visit every channel through the real UI before each restored-profile
measurement. This prepares roughly 50 cached messages per channel and exposes restart costs after
extended use. Those visits are excluded from startup timing. The result must retain at least
`channels * 50` cached messages. The default `--restore-cache=opening` restarts immediately after
the fresh launch; the optimized app normally has 50 cached messages then. Compare populated-cache
restarts separately from opening-only restarts.

`firstConversationVisit` measures the first Design visit separately from repeated cached switches.
Its `cachedAtLaunch` flag distinguishes those two cache preparations. It is one observation per
run, not a latency percentile. `--profile=true` saves a sender `composer.cpuprofile` during composer
sends and `search.cpuprofile` during UI searches. Profiling adds overhead; use unprofiled runs for
performance comparisons. With `--backlog`, it also saves `backlog-startup-N.cpuprofile` and
`backlog-visits-N.cpuprofile` for each receiver cycle. Startup profiling begins after Electron's
first window and CDP profiler initialization, then ends at the realtime-live checkpoint. The
sample's `startupProfileStartMs` records that offset from launch; the profile does not cover the
whole process startup. Visit profiling covers all three channel verification visits, including
the already-selected General channel. Unprofiled launches skip the early CDP profiler setup.
Profiled backlog starts also record `cacheReads`: successful `IDBObjectStore.getAll` and
`IDBIndex.getAll` results, with store/index names, row counts, renderer-clock start times and
elapsed read durations. The probe stores no message values. It is installed after `firstWindow`
and profiler initialization, and captured immediately after the realtime-live checkpoint; it does
not cover earlier startup, `get`, cursors or key/count reads. `installedAt`, `capturedAt` and each
entry's `startMs` use the renderer's performance time origin; `ms` includes result delivery and
event-loop scheduling, not decryption. `started` counts initiated calls; the difference from the
entry count can include unfinished or failed requests. The original prototypes are restored before
later interactions. This probe runs only with startup profiling, so use unprofiled runs for latency
comparisons.

Use `--explain-search=true` to retain `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the repository's
actual `searchneedle` query in `searchPlan`. The runner captures the SQL and bound parameters while
executing the real repository method against its synthetic database, then explains that statement
after all timed interactions have finished. This does not change the timed search path or page size.
Delayed scenarios also capture a first-visit loading screenshot after all measured interactions.

Use `--backlog=300` to measure reopening after 300 messages arrive while the receiving app is
closed. After the normal interactions, the runner records Claire's durable cache cursor and closes
her process. Woots sends the messages through the real desktop preload/HTTP path, split across
General, Design, and Performance 004, then closes. Claire reopens her saved profile. The runner
requires all cumulative generated message IDs in her persistent cache, a cursor at least as new
as the final send, and every cumulative generated body while traversing each channel's full loaded
history. Traversal also requires the number of distinct rendered IDs to equal the loaded count.
It does not compare the exact text of every original seeded message. No backlog events are
fabricated in SQL. Use `--restore-cache=all` to start this scenario with a populated cache.

This adds `samples` backlog cycles, each with another batch of messages; cache size therefore grows
between cycles and is recorded per sample. There is no discarded backlog cycle. Writes and sender
launches are outside receiver timing. `backlog[].readyMs` and `connectedMs` use the normal startup
checkpoints. `visits[].viewportMs` now measures channel click to one visible row from that
conversation, followed by two animation frames. All three timed visits finish before
`visits[].traversal` walks each complete loaded history and checks cumulative generated bodies.
Traversal is excluded from the visit timer and reports `loadedRows`, `renderedIds`, and
`verifiedMessages`.
Each visit now also records `renderer` CDP duration deltas in milliseconds for script, task, layout
and style recalculation. Metric calls surround the existing in-page viewport timer and can include
other renderer activity in that slightly wider interval. The calls also allow time between visits;
compare these deltas and new experiments against a control with the same probe. With `--profile`,
each visit also records `cacheReads` through the shared IndexedDB observer. Its interval begins
before the first metric call and ends after the second, and can include reads completed after the
viewport becomes visible. Observer installation/removal is outside the renderer metric interval,
while the success listeners add profile-only overhead inside it. These observations cannot be
attributed exclusively to the selected timeline and do not isolate decryption or React time. The old `visits[].ms` required all expected bodies before completing its timer;
do not compare it with `viewportMs` as though their difference were an application speedup. The scenario measures restart catch-up on a healthy local connection, not a
network interruption in a running app. It saves `backlog-N.png` for each cycle and captures the
actual first 100-event sync query in `backlogPlan` after all timed work, with the desktop's event
capabilities enabled. Its `EXPLAIN ANALYZE` timing is one query-plan observation, not a percentile.
After the final timed visit, it scrolls a newly received message into view and saves
`backlog-latest.png`. This final screenshot does not affect a later measurement cycle.
Each cycle also measures composer typing after the timed conversation visits and full-history
traversal, at the end of Performance 004. Earlier typing reports measured before traversal;
compare the new sequence only with controls that use it. It inserts one
warmup character, then `iterations` measured characters through Playwright text insertion, waiting
two animation frames per character. `typing.toFrame` records the driver-clock samples;
`insertText()` dispatches input events without keydown/keyup events. `typing.scriptMs` and
`typing.taskMs` record cumulative CDP renderer durations over the measured
loop, excluding warmup, the final input check, screenshot, and draft clearing. They include other
renderer work during that interval and are not isolated React costs or per-character latencies.
The helper requires the full expected draft and records the mounted message count, then clears the
draft. It saves `backlog-typing.png` in the final cycle. Compare these fields only between runs
containing this probe; earlier backlog runs have no corresponding typing measurement.
The final cycle also records `layout` checks for tail/middle-row geometry and reaction controls,
with `layout-actions.png` showing the picker. It then appends one real 81-paragraph Markdown
message to verify tail attachment, first/last paragraph navigation, full rendered paragraph text,
and persistence, recording `tallLayout` and `layout-tall-tail.png`. These checks execute after all
timings. A second message arrives while the app is scrolled back into the tall message; the check
requires the reading position to stay in place and saves `layout-reading.png`. Together these
checks add a reaction and two messages. A final `olderHistory` probe also selects Design and clicks
Load older until the loaded count grows, recording every click and its resulting count. It traverses
the resulting history, requires every previously loaded ID to remain reachable, and saves
`older-history.png`. Its timings exclude conversation selection, initial scrolling, final traversal
and the screenshot. The automation clicks again immediately after each completed action; its total
time does not include a person's reaction time between unsuccessful clicks. The control can require
several clicks; the optimized runtime continues through overlapping pages within one action.
The probe also records `olderHistory.renderer` CDP deltas over the action interval. Fields ending
in `Duration` are milliseconds; `LayoutCount` and `RecalcStyleCount` are counts. These include other
renderer work during the interval, not only the clicked handler. `olderHistory.requests` contains
server response records received during the interval; their handler times exclude IPC, transport,
cache and rendering work. With `--profile=true`, the probe saves `older-history.cpuprofile` over
the same action. Metric collection and profiler start/stop surround the elapsed timer, so their
interval boundaries differ slightly. Use unprofiled runs for elapsed-time comparisons.

`finalCache` rereads every cumulative backlog ID, newly fetched older-history ID and both post-timing
message IDs before close, while `cache` remains the timed backlog's durable check. This later probe
adds history to the final cache and is excluded from the earlier startup, switch and typing samples.
The virtual-timeline experiment also tried search, prepend, unread and queued-send assertions.
Those probes and the candidate were rejected after a prepend failure; they are not part of the
retained suite and must not be counted as passing coverage. See the
[layout investigation](evidence-2026-09-06.tar.gz) (`docs/performance/layout-2026-09-06.md` in the archive) for coverage and limits, including normal read tracking.
The option accepts 0 (disabled, the default) or 3–1,000 messages per cycle.

The runner builds contracts/server and desktop before measuring. The benchmark build uses the
normal production build configuration with a compiled loopback API origin. It serves the built
renderer on the unpackaged app's permitted `http://127.0.0.1:5173` origin, without Vite's development
server or HMR. It creates a PostgreSQL cluster with a random loopback port and a unique desktop data
root under `.dev-data/performance/`. It never accepts an existing database URL or loads `.env.local`.
The cluster trusts local connections, uses locale C and normal PostgreSQL durability defaults,
and stops when the run finishes. Synthetic credentials and database files stay in the ignored
private run directory.

After stopping all run-owned processes and saving results, the runner removes its synthetic PostgreSQL data, Electron profiles and sign-in callback files. Scenario failures follow the same cleanup path; a shutdown or result-writing failure preserves runtime data for inspection. Results, logs, screenshots and CPU profiles remain. Use `--keep-runtime-data=true` only when you need to inspect or restart that specific synthetic runtime; those directories can consume hundreds of megabytes per run.

The command prints its `results.json` path. That file contains individual timing samples, response
counts/bytes by route, cache mode and row count, process measurements, machine information, and
hashes of the benchmark scripts, lockfile, and server/desktop/contracts build outputs. The directory
also contains process logs, `workspace.png` of the measured history state, and `search.png` of the
search results after the timed search loop. Keep results from failed
runs for diagnosis, but use only `status: "complete"` runs for comparisons.

The worktree lock prevents simultaneous benchmark runs. Port 5173 must be free; a conflict fails
without stopping its owner. SIGINT/SIGTERM initiate cleanup. A forced kill or power loss can leave
an isolated PostgreSQL process or `.dev-data/performance/active.lock`; check that no run is active
and stop only that run's cluster with `pg_ctl -D <run>/postgres -m fast -w stop` before removing the
stale lock. Do not benchmark while another task rebuilds this checkout's shared `dist` files.

The final backlog cycle now also runs `behavior` checks after the older-history and tall-message
checks: a search jump, another prepend, initial unread placement, tail placement and pending sends
at and away from the tail. This adds two post-timing messages and another older-history page.
`behavior.newIds` and both pending-message IDs join the final durable cache check. Initial history
IDs come from full rendered traversal, including rows a virtualized view could unmount.

Unread setup uses the production repository transaction in the runner-created synthetic database;
it sends the normal read-state event to the receiver. It does not use headless read-cursor IPC,
which remains disabled, and does not establish HTTP authentication or normal visible read tracking.
The temporary message-write hold exists only in the benchmark server's local process channel.
A `window-behavior-progress.json` checkpoint records the completed prepend before later checks.

## Visible-window measurement (awaiting native validation)

`--presentation=visible` launches the primary app as a normal visible, focused desktop window.
The second signed-in client stays hidden. The runner sets the primary content area to 1280×800
and records the native window state, renderer focus, visibility, headless flag and pixel ratio.
It rejects a lost-focus or hidden-window event after observation begins, even if the window has
regained focus by the next checkpoint. Keep the Mac unlocked and the benchmark window in front.
Compare visible runs separately from hidden runs and compare only matching pixel ratios.
`presentation.foregroundObservationStartMs` records when focus monitoring begins after window
creation; `foregroundReadyMs` measures from that checkpoint to content readiness. The usual
`readyMs` still includes process launch and the earlier, unobserved initialization interval.

```sh
npm run perf:baseline -- --presentation=visible --channels=200 --restore-cache=all --samples=3 --iterations=20 --label=visible-large
```

This mode covers startup, channel visits, typing, outgoing messages, search and older-history
loading. The existing recipient timings still end at the hidden second client. After the timed
composer samples, a separate `visibleReadTracking` probe sends from that client to the visible
primary app, traverses its history and requires the canonical received message to become the
server's last-read message. The probe reads bootstrap through production IPC and requires a
successful read-cursor HTTP PUT; it never writes a read cursor directly. It saves
`visible-reading.png`. This is a correctness probe, not an incoming-message latency distribution.
The marker message remains in the history measured by the later paging probe, so those row counts
are not identical to the hidden scenario.

The default remains `--presentation=hidden`. Visible mode currently rejects `--backlog` because
that lane's unread setup and focus ownership have not been adapted to normal read tracking.
The first visible pilot failed before workspace readiness while the Mac was locked. No visible
measurement or read-tracking success has been established. See the
[visible measurement and larger-history report](evidence-2026-09-06.tar.gz) (`docs/performance/visible-and-scale-2026-09-06.md` in the archive).

## What the measurements include

| Field                       | Start and completion                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup[].readyMs`         | Playwright Electron launch begins → authenticated workspace, General header and a canonical timeline row exist → two animation frames                      |
| `startup[].connectedMs`     | Same start → the desktop reports realtime `live`, after the content check                                                                                  |
| `startup[].requests`        | Server HTTP responses between launch and readiness/live/cache-mode checks; includes authentication probes                                                  |
| `bootstrapIpc`              | Renderer calls the real preload bootstrap API → validated response; first catalog page only                                                                |
| `history50Ipc`              | Renderer calls real history API → 50 validated messages                                                                                                    |
| `searchIpc`                 | Renderer calls real search API for a matching term → validated results                                                                                     |
| `switchConversationDom`     | DOM click on alternate General/Design buttons → correct cached message rows → two animation frames                                                         |
| `sendToReceiverDom`         | Direct sender preload call → canonical message row on a second Electron client → two animation frames                                                      |
| `composerSendToReceiverDom` | Submit a filled composer → real renderer outbox, encryption, IPC, HTTP, PostgreSQL, WebSocket, receiver cache and canonical DOM row → two animation frames |
| `composerLocalFeedback`     | Same composer submission → sender message row (pending or committed) → two animation frames                                                                |
| `typingToFrame`             | Playwright inserts one character in the focused composer → two animation frames; final text length must match                                              |
| `searchSubmitToDom`         | Submit a changed, matching search term → fresh search result rows → two animation frames; filling is excluded                                              |
| `searchBrowser.rows`        | In the renderer, immediately before the same form submission → MutationObserver sees fresh result rows                                                     |
| `searchBrowser.paint`       | Same renderer start → two animation frames after those rows appear; independent of Playwright selector polling                                             |
| `historyGrowth`             | Click Load older messages → larger loaded canonical count → two animation frames, three successive pages; complete ID traversal follows                    |
| `idle`                      | Five-second interval after a two-second settle, one restored desktop; sum of RSS and CPU time for its process tree                                         |

The startup content boundary changed during the windowing investigation: the original probe
required seeded General message text, while the current probe requires the authenticated General
header and a canonical row. Newly received messages can fill the first viewport. Compare current
startup samples against a control with this same boundary.

The DOM measurements use actual app handlers and state. The animation-frame waits add a measurement
floor; these are not isolated handler timings, OS input-to-photon latency, or proof of a displayed
frame in the hidden window. Cached switching includes a discarded visit to the other channel, so
it does not measure the first uncached visit. The transport send deliberately bypasses the sender's
outbox; the separate composer measurement includes it.

`searchSubmitToDom` retains the original driver-side measurement for comparison with the original
baseline. Playwright's selector wait uses retry delays (20 ms, then 50 ms, then longer waits), so
it can report results well after the DOM has changed. `searchBrowser` records both DOM appearance
and two animation frames with the renderer's clock alongside that measurement. Its samples exclude
the same warmup. Compare browser timings only with runs that contain this probe; do not substitute
them into the original driver-timing series or describe their difference as an application speedup.
Neither measurement proves physical presentation in the hidden window.

The two initial 401 responses from identity and refresh probes are expected for each empty
profile. The runner requires exactly those probes, persistent encrypted caching, no errors on
restored startup, and no errors in measured operations. HTTP route timings include the optional
server delay. Bytes count serialized response bodies, without headers, TLS, compression or
WebSocket frames; they are not total network bytes.

The delay scenario adds 40 ms before each HTTP handler on localhost. It is a sensitivity experiment
for sequential requests, not emulation of a real network RTT, bandwidth, TLS, packet loss, or
WebSocket latency. Do not extrapolate its message-delivery times to a WAN.

The fixtures have two humans, public channels plus one DM, and short synthetic Markdown messages.
Historical messages are inserted in bulk with consistent high-water sequences. They have no
historical sync events; new measured messages use the real write path. The original baseline cached the
latest 50 messages per channel. Current cache preparation is described above. This does not cover an offline
client replaying a large event backlog, populated task lists, thread-heavy conversations,
attachments, maximum-length Markdown, agent runtime streaming, or server concurrency/capacity.

## Using the targets

Use the proposed targets in the baseline report as planning budgets, not CI failures. Compare the
same fixtures, hardware, build mode, cache mode, and measurement boundaries. Report both the raw
samples and the arithmetic median; p95 is the nearest-rank observation. Three starts cannot
establish a reliable startup tail, and 20 interaction samples are an initial estimate, not a
production SLO. Repeat the suite in separate batches before claiming an improvement, especially
for RSS, CPU and small timing changes. Never meet a budget by disabling encryption, authorization,
validation, persistence, or acknowledgement/catch-up correctness.

Backlog runs also save `backlog-progress.json` after each completed timing cycle. It is always
marked `partial`, because later history/layout/durable checks may fail. Use it for diagnosis after
a failed run; do not treat it as equivalent to a complete `results.json`. The first-viewport timer
requires computed row visibility as well as viewport intersection. The tall-message incoming check
samples reading position in the same browser evaluation that initiates the send and saves
`layout-anchor-trace.json` with before/after geometry.

Search-jump checks require the target to be visible and centered when scrolling permits it. Near the first or last row, the probe instead requires the corresponding scroll boundary; it still rejects off-center interior targets. This allows the three-message backlog fixture without requiring empty space beyond the end of the timeline.

For a minimal backlog, the unread probe uses the loaded predecessor of its target, which may be a seeded message. The pending-send reading check uses the earlier prepend anchor so it remains away from the live tail even when only one new message arrived in that conversation. These are post-timing checks.
