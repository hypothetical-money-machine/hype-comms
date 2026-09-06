# Verification of the PR split

Each intermediate branch passed `npm run check` before publication. Server changes also passed the complete opt-in PostgreSQL suite: 423 tests for indexed sync and 425 after search. The final application state has 1,898 desktop tests, 194 default server tests plus 231 opt-in PostgreSQL tests, 145 CLI tests and 150 contracts tests. The tooling adds statistics and runtime-cleanup tests.

The six application PRs reproduce all 20 retained application source/test files byte-for-byte. The benchmark-only publication changes add automatic runtime cleanup and correct small-fixture behavior probes. [Verification logs and native results](publication-validation.tar.gz) include the source-equivalence hashes and every final branch check. These small smoke runs establish behavior, not improvement estimates; historical matched performance evidence is in the [original archive](evidence-2026-09-06.tar.gz).

| Order | PR                                                                                         | Checked application commit                                                           |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1     | [sync-lookup](https://github.com/hypothetical-money-machine/hype-comms/pull/107)           | `bf1831442b2387eee6254bd2106e06c553f58be7`                                           |
| 2     | [search](https://github.com/hypothetical-money-machine/hype-comms/pull/108)                | `e9d6ffe3ab9ad84197b1ea5d4e44f2d17b3abf73`                                           |
| 3     | [startup-cache](https://github.com/hypothetical-money-machine/hype-comms/pull/109)         | `af3640001c2bcb3eaf5202790f559854d9525f5a`                                           |
| 4     | [rendering](https://github.com/hypothetical-money-machine/hype-comms/pull/110)             | `729a35c70b4e7866417b172db8107351905a0f17`                                           |
| 5     | [older-history](https://github.com/hypothetical-money-machine/hype-comms/pull/111)         | `b974ad9e5f5782d09c9a15ef130895e67b0e24d2`                                           |
| 6     | [timeline-interactions](https://github.com/hypothetical-money-machine/hype-comms/pull/113) | `72fa0bd841c8323121787affdba64afe89c59a20`                                           |
| 7     | Benchmark tooling, this branch                                                             | Same application commit as order 6; final tooling check and native result in archive |

## Fresh native smoke runs

All five final runs used Node 24.18.0, npm 11.16.0, PostgreSQL 17 and a production-built, unpackaged Electron app on macOS arm64. Each used five channels, 200 added messages per channel, one measured startup/restart and two repeated-interaction samples. Windows were hidden. Every final result has `status: "complete"`.

| Result file in verification archive | Added scenario                          | Evidence                                                                                         |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `native-3-results.json`             | 40 ms request delay                     | Deferred first-visit loading, startup/restart, send, search, switching and history               |
| `native-4-results.json`             | Default cache                           | Message rendering and interactions                                                               |
| `native-5-results.json`             | All conversations cached before restart | Cache restoration and older-history growth                                                       |
| `native-6-results.json`             | 300-message offline backlog             | Centered search, 0.125 px prepend shift, unread placement, pending sends at/away from tail       |
| `native-7-results.json`             | Three-message offline backlog           | Boundary-clamped search, 0.125 px prepend shift, unread and pending-send probes; runtime cleanup |

Fresh screenshots are committed with each renderer PR. The original 200-channel and 200,008-message performance comparisons are separate from these publication smoke fixtures.

## Failed probe attempts

The first three-message interaction run required a last-row target to sit in the viewport center, which the scroll boundary prevented. The first tooling run then reached unread setup and exposed an invalid assumption that every new message has an earlier new-message predecessor. These failed results remain in the verification archive and support no performance claims. One diagnostic run used Node 24.20.0/npm 11.19.0; the final successful run was explicitly pinned to the required Node/npm versions.

The final probe requires centered interior targets and the correct scroll boundary for edge targets. It obtains an unread predecessor from ordered loaded history, scopes the unread label to its conversation and handles the singular form. Pending-send checks away from the tail use the earlier prepend anchor, ensuring that the smallest supported backlog still exercises reading position. The unchanged application passes the established 300-message fixture and the corrected three-message fixture.

Runtime cleanup was observed after both a failed scenario and the final successful scenario. It removes only the stopped run's PostgreSQL data, Electron profiles and callback files, preserving results, logs, screenshots and CPU profiles. Shutdown or result-writing failures retain runtime data for inspection.

Foreground performance and normal visible read tracking remain unverified. Packaging CI validates packages but does not establish packaged-release performance.
