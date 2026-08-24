# Agent wake pilot

Status: the default-off transport, broker, private startup-repair core, fresh-authorization gate,
post-provider durable-write recovery, executable identity pinning, subprocess close barrier,
strict rollout-evidence manifest validator, and credential-free local evidence journal are
implemented and verified. The implementation is ready for review. Live Grok Bot activation, an
installed signed/notarized pilot, the 24-hour soak, and retirement of the external 15-minute poll
are owner-run post-merge rollout work, not this PR's definition of done. Wren is the current name of
the agent formerly called Jules and owns the desktop Wake slice; Wren is not a rollout identity.

## Implementation goal

Use this statement for the implementation task:

> Deliver Epic 1 — Wake as a default-off, event-driven wake path for Hype Comms agent identities.
> Wren's desktop slice provides the hook. Every post-enrollment, non-self one-to-one DM or
> server-verified @mention produces one deterministic, body-free wake keyed by workspace ID, agent
> user ID, and message ID. Delivery is at least once and deduplicated before activating the bound
> runtime. The runtime can fetch exactly the referenced message through the existing Comms CLI but
> never receives injected history. Delivery survives reconnects, duplicates, and crashes; keeps
> credentials out of renderer IPC and logs; and fails visibly on cursor loss or ambiguous
> activation. Include the signed pilot build lane and strict rollout-evidence tooling. Keep the
> feature default-off outside explicitly selected builds. Do not change presence, typing, read
> receipts, or held work #201, #203, #212, or #223.

Wren owns the desktop implementation slice. The owner-run rollout will select one actual named Grok
Bot as the live Hype Comms `agent` identity. A target configuration's opaque `adapterId` identifies
the wake adapter; it is not Wren's name or a new set of Comms credentials. Task-only `bot`
identities are outside this path.

## Implementation definition of done

- Strict shared contracts classify eligible DMs and verified mentions and derive stable body-free
  wake IDs; server bootstrap and realtime authorization are agent-scoped and fail closed.
- The CLI supplies resumable body-free `wake watch` output and exact single-message fetch without
  history hydration.
- Electron main owns a default-off durable FIFO, dedupe, retry, ambiguity repair, fresh-auth gate,
  private operator interface, and pinned source/target process boundary; nothing is exposed to the
  renderer.
- The signed macOS arm64 pilot workflow and package verifier assert Wake enablement, updater
  isolation, signing/notarization gates, package contents, and Electron fuses. Normal package and
  release jobs explicitly compile Wake out.
- The strict evidence validator and credential-free collector are present for the rollout owner;
  invalid, stale, body-bearing, or unauthoritative evidence fails closed.
- `npm run check`, `npm run test:db`, the arm64 package verifier, and independent Standards/Spec
  review pass with no P1/P2 findings. No files under the renderer change.

## Pilot topology and platform invariants

- Exactly one elected wake host may be active for one Hype Comms agent identity. The election is an
  operator invariant, not a distributed lease implemented by this pilot. A failover may start only
  after the previous host is confirmed stopped and its provider ledger is reconciled or transferred.
- One configuration file binds the selected Grok Bot's Hype Comms identity to its wake target. A
  single Electron process does not multiplex enrollments. Additional identities are later rollout
  work and require separately elected hosts unless the production launcher gains explicit profile
  support.
- Host-local `wakeId` dedupe is not global coordination. Running two hosts for the same identity can
  duplicate provider work, especially when provider receipt ledgers are not shared, and fails the
  rollout criteria.
- The first evidence platform is an installed production-flavor macOS arm64 package. Windows,
  Linux, and macOS x64 remain default-off and are not parity blockers for this pilot; enabling any
  of them requires its own packaged evidence lane.

## Delivery plan

1. **Freeze the boundary — complete.** Share one strict trigger classifier, body-free signal, and
   deterministic logical key across the CLI and desktop.
2. **Project realtime wakes — complete.** Authenticate as the enrolled agent, establish a
   future-only high-water and body-free conversation-kind snapshot, resume from a durable cursor,
   and surface expiry/reset as repair instead of replaying arbitrary history.
3. **Broker durably in Electron main — implemented and unit-verified.** Enqueue before source
   acknowledgement, process FIFO with bounded capacity, deduplicate, persist provider claims and
   receipts, recover crashes, and keep all controls behind default-off build and enrollment gates.
   Fresh source authorization gates queued delivery on every start/resume; a failed receipt write
   converges without process restart to visible provider-ambiguity repair when storage recovers;
   source and target executables have a pinned trusted identity; and shutdown waits for target
   process close. Installed-package evidence remains part of step 5.
4. **Expose the target boundary — complete.** The desktop invokes one pinned native adapter through
   a body-free, receipt-aware protocol. Selecting and configuring an actual Grok Bot adapter is
   owner-run rollout work.
5. **Ship rollout tooling — complete.** The repository includes the signed pilot workflow, private
   operator surface, evidence collector, and strict validator invoked with
   `npm run validate:agent-wake-evidence-manifest -- --artifacts /absolute/artifacts /absolute/rollout.ndjson`.
6. **Run the rollout — post-merge owner checklist.** Bind the selected Grok Bot, run the packaged
   matrix and soak, then identify and retire exactly its separately managed 15-minute polling job.

## Delivery shape

The implemented pilot follows this flow:

```text
agent token in private CLI profile
  -> agent-authenticated Hype Comms realtime
  -> strict CLI wake projection
  -> durable Electron-main FIFO and dedupe
  -> one fixed provider executable
  -> adapter disposition
```

Target-correlated acceptance evidence belongs to the post-merge rollout, not the implementation
PR.

`hype-comms-cli wake watch --json [--after CURSOR]` emits only three strict records:

- `agent.wake`: workspace, agent, conversation, message, optional thread-root, reason, sequence,
  timestamp, at-least-once marker, and deterministic wake ID;
- `agent.wake.checkpoint`: the highest safely observed workspace cursor; and
- `agent.wake.repair_required`: a body-free cursor-expiry/reset/overflow control.

The signal, wake bootstrap, CLI stdout, broker state, provider stdin, renderer IPC, and evidence
record have no message body, prompt, history, provider credential, or agent token. Wake bootstrap
uses the agent-only `GET /v1/agent-wake/bootstrap` route, which returns only agent/workspace IDs,
one high-water cursor, and at most 5,000 visible conversation ID/kind pairs captured in one
repeatable-read snapshot. It fails rather than truncating an over-limit projection. The trusted CLI
still receives the existing body-bearing realtime `message.created` envelope, although the
classifier never consults its body, and discards that body before stdout. This satisfies the pilot's
"no history injection" boundary; the server-native alternative below is required if even the local
projector must never receive trigger content.

A target may use `messageId` with its own authorized client—or
`hype-comms-cli messages get MESSAGE_ID --json`—to fetch exactly that trigger. It must not replace
the wake with a conversation-history request, workspace bootstrap, search, or full-history dump.

The wake ID is lowercase SHA-256 over the canonical UTF-8 tuple:

```json
["hype-wake-v1", "WORKSPACE_ID", "AGENT_USER_ID", "MESSAGE_ID"]
```

## Eligibility

| Input | Result |
| --- | --- |
| Non-self one-to-one DM | Wake: `direct_message` |
| Non-self message whose verified `mentionedUserIds` contains the agent | Wake: `verified_mention` |
| DM that also verifies the mention | One wake; verified mention wins |
| Unmentioned channel or group DM | Suppress and checkpoint |
| Self-authored or missing-author message | Suppress and checkpoint |
| Plain `@name` text without a verified mention ID | Suppress and checkpoint |
| Participated-thread reason alone | Suppress and checkpoint |
| Reaction, task, membership, read, or system event | No wake |

Fresh enrollment first captures the server bootstrap high-water and persists it before opening the
stream. Reconnect resumes from the last cursor durably handled by Electron main. The broker enqueues
or suppresses before acknowledging a record, pauses at its bounded capacity, and never silently
abandons an expired cursor.

## Provider process protocol

Electron resolves exactly one opaque `targetHandle` to one fixed absolute executable. It never uses
a shell. It sends one newline-terminated request on stdin:

```json
{
  "version": 1,
  "type": "agent.wake.request",
  "adapterId": "agent-runtime-v1",
  "attempt": 1,
  "wake": {
    "version": 1,
    "type": "agent.wake",
    "delivery": "at_least_once",
    "wakeId": "64-lowercase-hex-characters",
    "eventId": "UUID",
    "workspaceSequence": "42",
    "workspaceId": "UUID",
    "agentUserId": "UUID",
    "conversationId": "UUID",
    "messageId": "UUID",
    "threadRootId": null,
    "occurredAt": "2026-08-23T18:00:00.000Z",
    "reason": "direct_message"
  }
}
```

The executable returns exactly one strict JSON response line. Terminal success is
`accepted`, `duplicate`, or `coalesced` and must include the same `adapterId`, `wakeId`, `attempt`,
and an opaque `providerReceiptId`. Known non-acceptance can return `retry` with a bounded retry code
and optional delay, or `blocked` with an authentication, contract, or rejection code.

The adapter owns target-specific credentials in its private store or operating-system keychain.
Never put them in the configuration's executable arguments. The child environment is reduced to
non-secret process/profile-location variables and deliberately excludes `PATH`, `NODE_PATH`, and
`NODE_OPTIONS`.

The macOS arm64 pilot uses two deliberately narrow executable models:

- The source is an explicitly configured native Node runtime plus a separately configured
  `packages/cli/dist/bin.js` entrypoint. The build makes that entrypoint self-contained apart from
  canonical `node:` built-ins; it has no runtime `ws`, `zod`, or sibling-package dependency. The
  entrypoint is opened by Node and therefore may be a non-executable `0600` or `0644` regular file.
  The desktop never resolves its shebang or consults `PATH`.
- The target adapter must be one self-contained native executable. Scripts, shebang adapters,
  interpreter lookup, executable arguments, sibling dependency manifests, and dynamic target
  selection are rejected. The adapter reads its opaque binding from its own private store; the
  configuration's `arguments` array must stay empty.
  Its SHA-256 pin seals the exact accepted bytes. Mach-O load commands may reference only the
  platform dyld and absolute `/usr/lib` or `/System/Library` dependencies; sibling, `@rpath`,
  `@loader_path`, `@executable_path`, embedded dyld-environment, and custom rpath dependencies fail
  closed. The same dependency rule applies to the pinned Node runtime.

For this first lane, both native files must be **thin arm64 Mach-O `MH_EXECUTE`** files. Universal
Mach-O and x64 files are intentionally rejected rather than incompletely parsing or pinning one
slice. This is a pilot limitation, not a claim that universal binaries are unsafe; supporting them
requires validating and pinning the complete fat container and its arm64 executable slice.

Configuration load rejects non-canonical path spellings, leaf or ancestor symlinks, non-regular
files, owners other than the current account or root, group/world-writable files or ancestors, and
missing execute bits on native files. Every path from the filesystem root through the leaf is
pinned by device/inode, ownership, and mode; each leaf is additionally pinned by canonical path,
size, change timestamps, and SHA-256. Configuration carries a separately provisioned expected
SHA-256 for all three leaves, and load fails before re-enrollment if any observed digest differs.
The source rechecks both runtime and entrypoint before every spawn, and the target rechecks its
executable before every spawn. Configure already-canonical paths—for example, use
`/private/var/...`, not the macOS `/var` symlink spelling.

The expected digests are an authority only when copied from an independently approved build or
release record. Recomputing them from whatever is currently at the configured path provides no
authenticity. The private configuration is current-user-owned, so an attacker able to replace both
that file and the executable while the desktop is stopped can still establish a new enrollment.
For live rollout, install runtime, CLI entrypoint, and target under root-owned non-writable paths,
retain their approved release hashes, and independently verify the native runtime and target code
signatures. In-memory pins then add post-load/pre-spawn substitution detection; they are not the
root of trust by themselves.

Node's pathname-based `spawn` still leaves a narrow race after the final recheck and before exec
for an attacker able to mutate a current-user-owned path. Removing that residual requires a native
helper that executes an already-open descriptor (and a descriptor-relative ancestor walk); it must
be assessed alongside code-signing evidence in the live package lane.

Once a child process has spawned, timeout, abort, nonzero exit, malformed output, or lost output is
an ambiguous provider outcome. The broker blocks that wake for explicit reconciliation instead of
blindly invoking the provider again. A provider adapter should itself deduplicate by `wakeId`; an
API call with no native idempotency key needs an adapter-side receipt ledger.

The repository supplies the provider-neutral subprocess protocol, not a bundled production Grok
Bot adapter. The selected adapter executable must bind to the pilot Bot's Hype Comms identity and
satisfy the acknowledgement and dedupe contract above. For the Grok Bot target, the current
official xAI documentation describes
[human and Bot messaging](https://docs.x.ai/grok-bot/chat-and-collaboration) and
[scheduled or supported event-triggered routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).
The public routine documentation names Cursor account integrations such as a Slack message or
GitHub notification; it does not publish a generic inbound named-Bot address, event schema,
sender-facing acknowledgement, retry guarantee, idempotency key, completion callback, or receipt
API. That absence is an inference from the published surfaces, not a guarantee about private tenant
capabilities. A Grok Build headless process or the xAI inference API is a separately scoped agent,
not evidence for an actual persistent named Grok Bot.

The publicly documentable bridge closest to this epic is therefore a private, narrowly matched
Slack event source owned by the selected Bot's enabled routine. The desktop adapter would post only
the deterministic `wakeId` and `messageId`; the routine would use the Bot's existing Comms CLI
profile for the exact fetch. Slack accepting the pointer is not Bot acceptance, so the adapter must
remain pending until a Bot-initiated, wake-correlated completion callback is durably recorded. This
bridge still needs the selected Bot, its owning account, an approved private Slack source, the
routine definition, and a callback endpoint. If that integration is unacceptable, rollout requires
a written supported inbound contract from xAI/Cursor; an undocumented internal endpoint is not a
valid substitute.

## Opt-in configuration

The build-time switch defaults off:

```sh
HYPE_COMMS_AGENT_WAKE_ENABLED=1 npm run build --workspace @hype-comms/desktop
```

An enabled build still does nothing until
`HYPE_COMMS_AGENT_WAKE_CONFIGURATION=/absolute/path/to/wake.json` names a private `0600` regular
file. The environment carries only its pathname. The strict file has one agent and one provider:

```json
{
  "version": 1,
  "enrollmentId": "grok-bot-pilot",
  "expectedAgentUserId": "00000000-0000-4000-8000-000000000000",
  "source": {
    "credentialHandle": "hype-cli-grok-bot-pilot",
    "runtimeExecutablePath": "/canonical/absolute/path/to/thin-arm64-node",
    "runtimeExecutableSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "cliEntrypointPath": "/canonical/absolute/path/to/packages/cli/dist/bin.js",
    "cliEntrypointSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "profile": "grok-bot-pilot",
    "apiOrigin": "https://chat.example.com"
  },
  "target": {
    "targetHandle": "agent-runtime-primary",
    "adapterId": "agent-runtime-v1",
    "executablePath": "/absolute/fixed/agent-runtime-wake-adapter",
    "executableSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "arguments": []
  }
}
```

The repeated `a`, `b`, and `c` digests are illustrative; replace them with independently approved
artifact digests before enrollment.

The source profile must contain an agent token with `workspace:read`; save it through private
stdin, never a command argument:

```sh
printf '%s\n' "$AGENT_TOKEN" |
  hype-comms-cli --profile grok-bot-pilot --api-origin https://chat.example.com auth login-agent --save
```

The example enrolls the selected Grok Bot's existing Hype Comms identity and CLI profile while
naming a separate, opaque wake adapter. `adapterId` accepts any strict opaque handle; it is not a
closed list of agent names.

Changing the expected agent, credential handle, adapter, or target handle does not silently rebind
an existing inbox. Migrating that binding requires deliberate operator tooling; do not delete the
durable inbox by hand.

### Private startup operator request

Status, body-free broker evidence, provider repair, source reset, and resume are exposed through one
strict private startup request. Quit the elected desktop, create a new `0600` request outside its
user-data `agent-wake` directory, set
`HYPE_COMMS_AGENT_WAKE_OPERATOR_REQUEST=/absolute/path/to/request.json`, and relaunch the same
enabled package and wake configuration. The environment contains only the request pathname. The
desktop atomically writes a `0600` response under its dedicated private
`<userData>/agent-wake-operator/<requestId>.json` directory and continues running the wake source;
the request cannot choose an overwrite target or change another directory's permissions.

Every mutating request uses a unique lowercase 64-hex `requestId` as its durable operator action ID
and requires a non-secret `evidenceReference`. Replaying the identical request while its action is
retained in the bounded 2,048-entry audit is idempotent; reusing its ID for different content fails.
Example provider confirmation:

```json
{
  "version": 1,
  "requestId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "action": "confirm-accepted",
  "expectedRepairCode": "provider-outcome-ambiguous",
  "expectedRepairOccurredAt": 1800000000000,
  "expectedWakeId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "evidenceReference": "provider-activity-or-incident-reference",
  "providerReceiptId": "opaque-non-secret-receipt"
}
```

Other strict actions are `status`, `evidence`, `provider-retry`, `confirm-duplicate`,
`confirm-coalesced`, `source-reset-from-now`, and `resume`. Status/evidence requests contain only
`version`, `requestId`, and `action`; mutating requests add `evidenceReference`. Provider decisions
also require the exact `expectedRepairCode`, `expectedRepairOccurredAt`, and `expectedWakeId` from a
fresh status response; confirmations add `providerReceiptId`. Source reset similarly requires the
observed source repair code/time and its nullable wake ID. These optimistic preconditions prevent a
delayed command from repairing or interrupting a newer wake. A successful repair automatically
records a separate derived resume action and reopens the durable source. Remove the environment
variable after retaining the response. Before `provider-retry`, use the selected target adapter's
documented reconciliation procedure to prove and record non-acceptance; a broker retry alone cannot
clear an ambiguous target outcome safely.

## Failure and repair

- Agent-token revocation, identity/scope mismatch, invalid stream data, cursor expiry, and provider
  ambiguity enter durable `blocked-repair` state and emit body-free notices.
- Transient source and provider unavailability retry with bounded exponential backoff.
- A crash-restored `delivering` item is ambiguous; queued and due retry items resume in FIFO order.
- If a source failure arrives while a provider outcome is unknown, the durable provider repair
  retains that source failure as `deferredSourceRepair`. Provider reconciliation promotes it to the
  primary repair instead of discarding the source reset or re-enrollment action still required.
- The private startup operator interface can export status/evidence, confirm a
  provider-correlated accepted/duplicate/coalesced result, explicitly retry after adapter-specific
  reconciliation, reset an expired source from a newly captured high-water, and resume. Each
  mutation and resume is retained in the bounded durable audit ledger. Exercising the interface
  from an installed package belongs to the post-merge rollout.
- Structured logs contain only enrollment ID, adapter ID, cursor, wake ID, phase, and stable code.
  Credential handles, target handles, message bodies, child output, and caught error text are not
  projected.

## Post-merge owner rollout checklist

These operational checks are intentionally outside the implementation PR's definition of done.
They remain available to the rollout owner; a mocked target, local adapter receipt, enum value, or
default-off build does not count as live target evidence.

### Functional and failure matrix

- Run both eligible triggers—one-to-one DM and server-verified mention—against one actual named
  Grok Bot's Hype Comms agent identity. Every input creates the expected deterministic `wakeId`,
  exactly one Bot activation attributable to that wake, and one exact-message fetch through the
  Bot's existing Comms CLI profile. A DM that is also a verified mention still produces one wake
  with `verified_mention` precedence.
- Prove self-authored DM, missing author, fake textual mention, unmentioned group DM/channel,
  participated-thread reason alone, reaction, task, membership, read, and system events produce no
  provider invocation while their source cursors advance durably.
- Prove fresh enrollment, disconnect replay, 100 deliberate duplicate replays for the pilot Bot,
  cursor expiry, server reset, token revocation, enqueue-before-ack, crash before provider
  invocation, crash after possible invocation, FIFO, capacity pause, retry exhaustion,
  completion-ledger bounds, and provider-ledger bounds. Revocation must be detected by the next
  notified/page flush or the 30-second heartbeat and enter repair within 60 seconds. After the
  broker observes the authorization failure, no new provider invocation may begin; an invocation
  already started under the prior authorization is aborted and reconciled as outcome-ambiguous.
  This pilot does not claim atomic ordering against the instant a revocation transaction commits: a
  replay page authorized immediately before that commit can still be sent. Eliminating that
  distributed race requires a server-side authorization lease/epoch or transactional delivery
  design. On every start and resume, fresh source authorization must succeed before any persisted
  queued wake can invoke its target.
- After a target may have accepted a wake, inject failure into the completion transaction and then
  restore the store. The enrollment must converge without process restart to visible
  `provider-outcome-ambiguous` repair for that exact wake; it must never remain durably `running`
  with no live supervisor.
- Provide a supported local-only operator command or equivalent privileged interface for status,
  provider confirmation, explicit provider retry, source reset-from-now, and resume. Exercise every
  action from a packaged build and retain its audit record. Direct durable-file editing is not an
  operator interface.
- Prove the elected-host invariant by recording one `wakeHostId` for the pilot Bot and showing from
  host/process evidence that no ineligible second host opened a source or target child. This is an
  operator-controlled gate, not a distributed application lease. Complete one controlled failover
  only after the former host and its children are stopped.
- Strict validation must find no body, prompt, history, agent token, provider credential, or caught
  child output in CLI stdout, durable wake state, provider stdin, renderer IPC, structured logs, or
  rollout evidence. Opaque credential/target lookup handles may exist only in the private
  configuration and private durable binding state; they must not appear in provider stdin, renderer
  IPC, structured logs, operator responses, or rollout evidence.
- Enrollment and every spawn must reject non-canonical paths, symlinks in any path component,
  non-regular leaves, files or ancestors not owned by the expected account or root, and
  group/world-writable files or ancestors. Source must independently pin and recheck its thin arm64
  native Node runtime and self-contained CLI entrypoint; target must pin and recheck its single thin
  arm64 native adapter. Target scripts, universal/x64 files, unknown or path-bearing Mach-O load
  commands, computed CLI module loads, and inherited `PATH`, `NODE_PATH`, or `NODE_OPTIONS` lookup
  must fail closed or be ignored as specified. Each observed digest must equal an independently
  approved expected digest. Post-load replacement of any path must fail closed before spawn. The
  live lane must additionally prove root-owned deployment paths and independently verify the
  runtime and target signatures so a stopped desktop cannot silently establish trust in
  user-replaced artifacts.

### Latency and soak thresholds

- Collect at least 30 unique accepted wakes for the pilot Grok Bot—15 DMs and 15 verified
  mentions—on a healthy network. Before each run,
  verify the server and wake-host clocks differ by at most 100 ms and record `clockSkewMs` as
  `wakeHostClockMs - serverClockMs`. `messageCommittedAt` and `soakStartedAt` are server-clock
  timestamps. `recordedAt`, broker/provider/fetch/activity observations, and manifest copies of
  external-authority times are wake-host-clock timestamps; retain the authority's original clock in
  its separately reviewed subject. The verifier subtracts each record's `clockSkewMs` whenever it
  compares host observations across records or with a server timestamp. Scheduler window durations
  remain comparisons within one scheduler export, while their observation-record chronology uses
  normalized `recordedAt` values. Measure `latencyMs` from the server event's `occurredAt` to the wake
  host's observation of the approved target-runtime success acknowledgement. Compute the nearest-rank
  percentile (`ceil(0.95 * n)`); p95 must be at most 5,000 ms and the maximum at most 30,000 ms. A
  matching Bot activity must become
  observable within five minutes.
- Run one continuous 24-hour packaged macOS arm64 soak for the pilot Grok Bot. The soak includes
  its 30 unique accepted wakes above, 100 duplicate replays, at least 1,000 suppressed realtime
  records, four source disconnect/reconnect cycles, two desktop restarts, one crash-before-target
  case, one post-handoff ambiguity, and its operator reconciliation.
- At the soak's completion: zero eligible wakes are lost; each unique `wakeId` has exactly one Bot
  activation attributable to that wake; duplicate replays create zero
  additional trigger activities; queue depth never exceeds 100; broker completions and the target
  receipt ledger never exceed 2,048 entries; repair is clear; and no CLI or target child remains
  alive five seconds after broker shutdown. Any failed criterion restarts the full soak.

### Strict rollout evidence record

Store one body-free NDJSON record per test case with exactly these fields; nullable fields remain
present as `null` so evidence cannot silently change shape:

```json
{
  "version": 1,
  "type": "agent.wake.rollout_evidence",
  "recordedAt": "ISO-8601 UTC",
  "runId": "UUID",
  "caseId": "stable non-secret string",
  "scenario": "direct_message | verified_mention | suppressed | replay | failure | operator | security | integrity | soak | poll_retirement",
  "result": "pass | fail",
  "gitCommit": "40 lowercase hex characters",
  "appVersion": "semver",
  "buildFlavor": "production",
  "platform": "darwin",
  "architecture": "arm64",
  "clockSkewMs": "wakeHostClockMs - serverClockMs; signed integer with absolute value at most 100",
  "wakeHostId": "opaque non-secret host election ID",
  "enrollmentId": "opaque non-secret enrollment ID",
  "agentIdentityLabel": "actual selected Grok Bot label",
  "targetKind": "grok_bot",
  "targetBotId": "stable provider-issued Bot identity ID",
  "targetIdentityAuthorityId": "provider Bot-directory authority ID",
  "adapterId": "opaque runtime adapter ID",
  "workspaceId": "UUID",
  "agentUserId": "UUID",
  "conversationId": "UUID or null",
  "messageId": "UUID or null",
  "wakeId": "64 lowercase hex characters or null",
  "reason": "direct_message | verified_mention | null",
  "sourceCursor": "unsigned decimal sequence",
  "attempt": "positive integer or null",
  "messageCommittedAt": "ISO-8601 UTC or null",
  "brokerDurableAt": "ISO-8601 UTC or null",
  "providerAcceptedAt": "ISO-8601 UTC or null",
  "latencyMs": "nonnegative integer or null",
  "providerReceiptKind": "adapter_issued | provider_issued | none",
  "providerReceiptId": "opaque non-secret ID or null",
  "providerActivityId": "opaque provider activity ID or null",
  "providerActivityObservedAt": "ISO-8601 UTC or null",
  "exactMessageFetchEvidenceId": "opaque request/audit ID or null",
  "repairCode": "stable repair code or null",
  "operatorAction": "confirm-accepted | confirm-duplicate | confirm-coalesced | provider-retry | source-reset-from-now | resume | null",
  "caseEvidence": {
    "type": "accepted_wake",
    "authorityKind": "provider_cli_correlation",
    "authorityId": "provider authority ID",
    "observationId": "unique observation ID",
    "observedAt": "ISO-8601 UTC equal to recordedAt",
    "fetchClient": "hype-comms-cli",
    "fetchCommand": "messages.get",
    "fetchEvidenceId": "same value as exactMessageFetchEvidenceId",
    "fetchedMessageId": "same value as messageId",
    "fetchAgentUserId": "same value as agentUserId",
    "fetchObservedAt": "ISO-8601 UTC",
    "fetchResultCount": 1,
    "historyRequestCount": 0,
    "targetActivationCount": 1,
    "wakeSource": "event_push",
    "pollSystemId": null,
    "pollAutomationId": null,
    "pollJobId": null,
    "pollSourceAuditId": null,
    "pollExecutionCountSinceDisable": null
  },
  "evidenceReference": "unique private authority-pointer basename",
  "evidenceDigestSha256": "64 lowercase hex characters"
}
```

Accepted live-target cases require non-null conversation, message, wake, reason, attempt,
message-commit, broker-durable, provider-acceptance, latency, receipt-ID, provider-activity, and
exact-message-fetch fields. Grok Bot records require an authoritative activation acknowledgement
and correlated Bot activity; an adapter-issued receipt alone is insufficient. When the approved
integration issues a receipt, use `providerReceiptKind: "provider_issued"`.
Suppressed cases require null `wakeId`, `reason`, `attempt`, broker-durable, provider-acceptance,
latency, receipt-ID, provider-activity, exact-message-fetch, repair, and operator-action fields,
with `providerReceiptKind: "none"`. A suppressed non-message case also uses null conversation,
message, and message-commit fields. Replay cases retain the original logical wake fields but must
have no attempt, new durable enqueue, target receipt, target activity, or exact-message fetch.

`caseEvidence` is a strict discriminated object rather than a free-form assertion:

- `accepted_wake` binds one provider activation to one
  `hype-comms-cli messages get <messageId> --json` result for the same Hype Comms agent, records one
  result and zero history requests, and identifies `event_push` as the wake source. The two final
  push-only records additionally bind the exact retired poll IDs, a scheduler source-audit ID, and
  zero executions since disable.
- `suppressed_event` binds the durable checkpoint and zero target invocations;
  `dedupe_replay` binds the original provider activity and zero new target invocations.
- `case_observation` binds a non-null induced time, typed authority, exact expected outcome, and target
  invocation count for every failure, operator, and integrity case. `security_scan` records zero
  matches for bodies, prompts, history, agent tokens, provider credentials, child output, and
  projected credential handles on the named surface.
- `soak_heartbeat` records broker state, queue and ledger sizes, and repair state under one soak ID;
  `soak_summary` records the interval, eligible/activated/lost/duplicate counts, maxima, final
  repair, and child-liveness result.
- `poll_inventory`, `poll_disabled`, `poll_zero_execution_window`, and
  `poll_zero_execution_summary` share one scheduler system, automation, job, owner, and `PT15M`
  schedule. They carry the approved change/audit IDs and explicit zero-execution interval bounds.

The validator deliberately rejects Wren, Jules, placeholder Bot labels, a target other than
`grok_bot`, unknown or missing fields, non-production/non-arm64 records, adapter-only receipts for
accepted live wakes, unsafe free-form or reused evidence references, inconsistent run or identity
fields, duplicate `caseId` values, incorrect deterministic wake IDs, failed records, stationary
accepted/suppressed cursors, replays preceding their original activity, and non-chronological
evidence. Each
`evidenceReference` is a unique strict basename for a separately retained artifact in the supplied
private artifact directory. The validator opens every referenced file without following a leaf
symlink, requires owner-only access and current-user or root ownership, hashes the opened file while
checking that its metadata did not change during the read, and compares `evidenceDigestSha256`.
Each artifact is at most 32 KiB and must itself be one canonical, body-free
`agent.wake.authority_reference` JSON pointer that matches the run, case, target Bot, identity
authority, case authority, and observation IDs; carries a digest of the separately retained
authority subject; and says `independentReviewRequired: true`. This binds the record to the exact
pointer bytes present during validation without copying logs, messages, credentials, or child
output into the NDJSON. It neither makes the pointer immutable nor proves the referenced authority
observation true. Retain minimal authority exports separately and never retain raw conversations or
secrets as Wake evidence.

Each authority pointer has exactly this shape:

```json
{
  "version": 1,
  "type": "agent.wake.authority_reference",
  "runId": "same UUID as the evidence record",
  "caseId": "same case ID as the evidence record",
  "targetBotId": "same provider-issued Bot ID",
  "targetIdentityAuthorityId": "same Bot-directory authority ID",
  "authorityKind": "same typed case authority",
  "authorityId": "same authority ID",
  "observationId": "same unique observation ID",
  "subjectDigestSha256": "digest of the separately retained authority subject",
  "independentReviewRequired": true
}
```

Canonical case IDs make the matrix mechanically checkable:

- healthy latency wakes use at least `latency-dm-001` through `latency-dm-015`, at least 14
  `latency-mention-NNN` records, and `latency-mention-precedence`;
- deliberate duplicates use at least `duplicate-replay-001` through `duplicate-replay-100` and
  refer to an accepted soak wake without a second target result;
- at least 1,000 suppressed records use `suppressed-<category>-NNNN`, covering
  `self-authored-dm`, `missing-author`, `fake-text-mention`, `unmentioned-group-dm`,
  `unmentioned-channel`, `participated-thread`, `reaction`, `task`, `membership`, `read`, and
  `system`;
- reconnects use `source-disconnect-reconnect-01` through `-04`, and desktop restarts use
  `desktop-restart-01` and `-02`;
- a continuous soak uses at least 97 chronological `soak-heartbeat-NNN` records, beginning within
  one minute of the first accepted soak message and never more than 16 minutes apart;
- the remaining required one-case checks are the exact IDs below.

```text
fresh-enrollment
disconnect-replay
cursor-expiry
server-reset
token-revocation
enqueue-before-source-ack
crash-before-target
crash-after-possible-target
fifo-ordering
capacity-pause
provider-retry-exhaustion
completion-ledger-bound
provider-ledger-bound
fresh-auth-start
fresh-auth-resume
completion-store-recovery
shutdown-child-reaping
operator-status
operator-confirm-accepted
operator-confirm-duplicate
operator-confirm-coalesced
operator-provider-retry
operator-source-reset-from-now
operator-resume
security-cli-stdout
security-durable-state
security-provider-stdin
security-renderer-ipc
security-structured-logs
security-rollout-evidence
security-credential-handles
executable-source-symlink-rejected
executable-target-symlink-rejected
executable-nonregular-rejected
executable-owner-rejected
executable-mode-rejected
executable-path-replacement-rejected
executable-ancestor-symlink-rejected
executable-ancestor-mode-rejected
executable-runtime-hash-rejected
executable-entrypoint-hash-rejected
executable-target-hash-rejected
executable-target-script-rejected
executable-target-unknown-load-command-rejected
executable-path-lookup-ignored
executable-root-owned-deployment
executable-native-arm64
cli-bundle-self-contained
runtime-signature
target-signature
host-election-single-active
host-controlled-failover
packaged-operator-interface
package-production-gate
package-updater-isolated
package-signature
package-notarization
package-install
soak-summary
poll-inventory
poll-disabled
poll-interval-01-zero
poll-interval-02-zero
poll-two-intervals-zero
poll-push-only-dm
poll-push-only-mention
```

One run must keep its package, Hype Comms identity, provider-issued Bot identity/authority, adapter,
and enrollment fields constant. It must contain exactly two distinct `wakeHostId` values: the
elected host and the later controlled failover host. Every record before the typed failover uses the
first host and every record at or after it uses the second; accepted soak wakes must exercise both.
Manifest ordering, host transition, replay, soak, and poll-observation chronology use each record's
server-normalized host time. All soak cases must precede `soak-summary`, which must be at least 24
hours after the first accepted soak message and no more than 16 minutes after the last heartbeat.
`poll-disabled` must follow the passing soak; `poll-interval-01-zero` and
`poll-interval-02-zero` must each cover another full 15 minutes with no execution;
`poll-two-intervals-zero` summarizes those scheduler audits; and the final push-only DM and mention
must be committed afterward. The verifier computes nearest-rank p95 and the maximum from the healthy
latency records after normalizing host timestamps by the recorded
`wakeHostClockMs - serverClockMs` skew.

Run the fail-closed verifier against a private, owner-or-root-owned, non-symlink regular file that
is not group- or world-writable:

```sh
npm run validate:agent-wake-evidence-manifest -- \
  --artifacts /absolute/path/to/private-artifacts \
  /absolute/path/to/rollout.ndjson
```

### Local evidence journal

The credential-free collector in `scripts/collect-agent-wake-evidence.mjs` durably journals one
already-observed case at a time. It does not contact Hype Comms, the Grok provider, the scheduler,
or the packaged desktop. For every case, it opens a separately retained private authority export,
hashes its stable bytes without following symlinks, derives the strict body-free authority pointer,
computes `evidenceDigestSha256`, and writes the private record and artifact as atomic files. The
authority export is not copied into the rollout directory. Retain that exact export unchanged—or
retain a stable authority query that can reproduce it—through independent review. The reviewer must
rehash or re-query the subject and compare it with `subjectDigestSha256`; a surviving pointer whose
subject was discarded is not evidence.

Initialize a canonical private directory once:

```sh
npm run collect:agent-wake-evidence -- \
  init --run-directory /canonical/absolute/path/to/wake-rollout
```

Each observation is a canonical owner-only `0600` JSON file with exactly this envelope. `record` is
the strict rollout record documented above with `evidenceDigestSha256` omitted; the collector
derives that field. `authoritySubjectPath` identifies the separately retained minimal authority
export whose digest the pointer records.

```json
{
  "version": 1,
  "type": "agent.wake.evidence_observation",
  "authoritySubjectPath": "/canonical/absolute/path/to/private-authority-export.json",
  "record": {
    "version": 1,
    "type": "agent.wake.rollout_evidence"
  }
}
```

The abbreviated `record` above only illustrates the envelope; a real observation must contain every
strict field and the typed `caseEvidence` for its case. Collect it with:

```sh
npm run collect:agent-wake-evidence -- \
  collect \
  --run-directory /canonical/absolute/path/to/wake-rollout \
  --observation /canonical/absolute/path/to/observation.json
```

Replaying the exact same observation is idempotent. Reusing a case ID, observation ID, or artifact
name for different evidence fails closed. The journal also rejects run-identity changes,
non-chronological normalized timestamps, non-private files, symlinks, changed authority exports,
schema additions such as a message body, and tampered pointer artifacts. Each contender stages and
syncs a private record before atomically publishing its UUID-named `.collector-lock-*.json` file.
The unique pathname is never reused, so one stale contender can be removed without racing a later
owner at a shared lock path. A well-formed lock is reclaimed automatically only when two liveness
checks report that its recorded PID does not exist. Simultaneous live contenders fail closed (both
may back off), a live or reused PID remains the owner, and permission errors, malformed records, or
any other ambiguous liveness result fail closed. In those ambiguous cases, first prove that no
collector process is active, retain incident context, and then remove only that exact UUID-named
lock file. A legacy shared `.collector.lock` also fails closed and requires that manual procedure.
This PID policy assumes the protected local filesystem required below; it is not suitable for a
shared filesystem spanning hosts with independent PID namespaces.

The run directory, observation, authority subject, and every ancestor must use canonical paths and
must be owned by the current account or root. The collector rejects group- or world-writable
ancestors except a root-owned sticky directory such as the standard Linux `/tmp`; the randomly
named child and every collector-owned directory and file beneath it remain owner-only `0700` or
`0600`. Run this on a protected local filesystem. Node exposes leaf `O_NOFOLLOW` and metadata
checks but not the full descriptor-relative `openat`/`renameat` sequence needed to pin every parent
across later pathname operations. A same-account or privileged actor able to rename a checked
ancestor in the small check-to-open window remains a local TOCTOU risk; eliminating it requires a
native descriptor-relative helper.

Create an inspectable partial NDJSON snapshot during the run:

```sh
npm run collect:agent-wake-evidence -- \
  snapshot --run-directory /canonical/absolute/path/to/wake-rollout
```

An exact idempotent collection retry leaves this snapshot intact. Before committing any new journal
record, the collector durably removes `rollout.ndjson`, so an older snapshot cannot remain beside a
newer journal after a crash. Run `snapshot` again whenever an updated partial view is needed.

After the soak and poll-retirement cases are collected, `finalize` rebuilds `rollout.ndjson` from
the private numbered journal and runs the complete manifest and artifact validator against a
private fsynced candidate. It atomically publishes that candidate only after validation passes; a
failed finalize leaves no new official manifest and preserves any previously published snapshot:

```sh
npm run collect:agent-wake-evidence -- \
  finalize --run-directory /canonical/absolute/path/to/wake-rollout
```

The collector closes the unsafe local file-assembly gap, but it is not a live test driver and does
not make an operator-authored record authoritative. The rollout still needs trusted producers for
clock-skew observations, packaged broker status/evidence, provider activation and exact-fetch
correlation, server fault injection, host/process inspection, security scans, scheduled soak
heartbeats, and scheduler inventory/disable/zero-execution exports. It also needs an orchestrator to
drive the matrix and keep heartbeat gaps below 16 minutes. Until those producers and the actual
Grok Bot binding exist, the repository cannot run the 24-hour soak unattended.

The manifest validator and adversarial fixtures are implemented in
`scripts/validate-agent-wake-evidence-manifest.mjs` and its test. This command is only a preflight:
it checks strict NDJSON shape, cross-record arithmetic, private artifact existence, and artifact
digests. It does not certify the rollout. Artifact hashing proves existence and integrity, not the
truth of an arbitrary file's claim. Completion review must independently inspect or query the
referenced target, package, host/process, server, and scheduler authorities. Live authority
producers and that independent review are still required; collected operator-authored records and
artifacts alone are not rollout proof.

### Repository and packaged macOS lane

- `npm run check` passes from a clean install using the repository-pinned Node and npm versions.
- Build the pilot with
  `HYPE_COMMS_BUILD_FLAVOR=production HYPE_COMMS_AGENT_WAKE_ENABLED=1 HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED=1 npm run package:desktop:mac:arm64`,
  then pass
  `HYPE_COMMS_BUILD_FLAVOR=production HYPE_COMMS_AGENT_WAKE_ENABLED=1 HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED=1 npm run verify:desktop-package`
  and
  `HYPE_COMMS_BUILD_FLAVOR=production HYPE_COMMS_AGENT_WAKE_ENABLED=1 HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED=1 npm run verify:desktop-package:macos-release`
  on the signed macOS arm64 evidence host.
- The manual `desktop-package-smoke.yml` workflow input `agent_wake_package_evidence` is default-off.
  Setting it to `true` builds the signed/notarized arm64-only pilot package, verifies the packaged
  Wake build flag and updater isolation, and retains the package artifact for seven days. Automatic
  updates are compiled off only in this evidence artifact so the installed bytes cannot change
  during the 24-hour soak; normal production releases retain their updater. This supplies a package
  for the live lane; it is not soak or target evidence, and native-notification capture remains
  independently conditional.
- Install and launch the produced package outside the repository. Configure the real (not symlink)
  path of a trusted thin arm64 Node 24 runtime and the built self-contained CLI entrypoint; verify
  both native runtime and target report arm64 Mach-O executables and valid expected signers before
  enrollment. Populate the three expected SHA-256 values from approved release/build records, not
  by trusting the installed paths, and install all three leaves and ancestors root-owned and
  non-writable by the desktop account. Prove the package invokes those fixed paths without `PATH`,
  `NODE_PATH`, or `NODE_OPTIONS`, run the matrix and soaks above, and retain the runtime, CLI,
  target, and package hashes; signing/notarization result; command outputs; strict NDJSON evidence;
  and provider-side activity/audit exports.

### Poll retirement

The poll is not implemented in this repository or its deployment manifests. Before removal, record
its external system, immutable deployment/automation ID, exact job ID, owner, current schedule,
last successful run, and approved change record. Only that owner may disable it, after the pilot
Bot's soak passes. Retain the disable timestamp and scheduler audit event, observe at least two
former 15-minute intervals with zero executions, then send one DM and one verified mention to the
same Grok Bot through the new wake lane. The live rollout remains incomplete until both wakes pass
and the evidence proves no duplicate wake source remains.

## Alternatives considered

1. **Server-native wake WebSocket.** The server emits a separate body-free event type. This is the
   cleanest long-term wire boundary but adds ticket capability, rolling-release, and repository
   work before the desktop slice can prove provider behavior.
2. **CLI projection plus durable Electron broker (implemented pilot).** Reuses agent auth and the
   current realtime replay window while containing message-bearing events inside the trusted CLI
   projection. It is the smallest end-to-end slice and keeps providers body-free.
3. **Hosted durable mailbox/queue.** The server stores per-agent wake receipts for delivery while
   every desktop is offline. This provides stronger offline availability, but adds server state,
   retention, fanout ownership, and operational complexity that the current running-desktop goal
   does not require.
