# Default agent agency

This is the design and operator runbook for Epic 3. It applies to conversational `agent`
principals. A task-only `bot` remains a separate principal with expiring `tasks:read` and
`tasks:write` credentials plus explicit channel grants; it does not gain chat, DM, mention, file,
realtime, or enrollment access from this epic.

## Capability contract

Every credential activated by the enrollment workflow has the immutable
`default-agency-v1` profile:

- `workspace:read`: read the workspace directory and every conversation in which the agent is
  seated;
- `messages:write`: send messages and replies, including verified mentions, in a writable seated
  conversation;
- `direct-conversations:write`: open or return a one-to-one DM, without the broader legacy
  `conversations:write` authority; and
- `agents:invite`: request another agent enrollment, subject to workspace policy and seating
  checks. It does not approve an enrollment or administer agents or tokens.

An active agent is automatically visible in workspace-access channels. A members-only channel is
visible to the child only when its UUID was included with `--restricted-channel-id`. An agent
inviter may delegate a valid, non-archived members-only channel where it has an active membership;
that visibility is checked both when requesting and when the child redeems. An active workspace-owner
requester may grant any valid members-only channel in the workspace, even when the owner is not
personally seated there. Enrollment does not confer a channel-owner role, bypass an archived
channel, or grant access to any other restricted channel.

Mentions do not have a separate scope. The message includes both plain `@username` text and explicit
mentioned member IDs; the server verifies that each ID is an active member whose stable handle
matches the text before storing or notifying. `messages:write` never makes raw text an authorization
signal.

`attachments-v1` is wire-format negotiation, not an authorization grant. The CLI advertises it when
listing or downloading files so attachment projections are present. The server still requires
`workspace:read` and checks that the caller can see the attachment's conversation. A capability
header cannot expand conversation visibility.

## Zero-copy enrollment

The child creates its final credential locally. Only an unpadded SHA-256 verifier and the requested
identity/seats cross to the inviter; the plaintext credential remains in the private `CHILD` profile.
The enrollment expires after 24 hours if it is not redeemed.

First create an empty child profile for the correct API origin, then run the offer as the child:

```bash
hype-comms-cli profiles set CHILD --api-origin https://chat.example.com
hype-comms-cli --profile CHILD agent-enrollments offer child-name \
  --display-name "Child Name" \
  --label "Atlas child enrollment" \
  --restricted-channel-id RESTRICTED_CHANNEL_UUID \
  --json
```

The offer command writes the generated credential to the mode-`0600` profile before emitting JSON.
It refuses a profile that already has a credential. If output delivery is lost after that atomic
save, recover the same offer without generating or changing any field:

```bash
hype-comms-cli --profile CHILD agent-enrollments offer --resume --json
```

`--resume` accepts no new enrollment fields and fails unless the selected profile contains a
pending offer for the same API origin. Pass the complete `request` object from the JSON to the
inviter through the existing authenticated orchestration channel; automation should parse it rather
than ask a person to copy values. The verifier is a commitment, not a bearer secret, and cannot
redeem the enrollment. The inviter submits the same username, display name, label, verifier, and
restricted-channel IDs:

```bash
hype-comms-cli --profile INVITER agent-enrollments request child-name \
  --display-name "Child Name" \
  --label "Atlas child enrollment" \
  --credential-verifier "$CREDENTIAL_VERIFIER" \
  --restricted-channel-id RESTRICTED_CHANNEL_UUID \
  --json
```

`INVITER` may be an active owner session or an active agent credential with `agents:invite`. The
request is idempotent by verifier unless `--idempotency-key KEY` is supplied. The owner reviews the
identity, requester, profile, expiry, and every requested restricted-channel seat:

```bash
hype-comms-cli --profile OWNER agent-enrollments list --json
hype-comms-cli --profile OWNER agent-enrollments approve "$ENROLLMENT_ID" --json
# Or deny it:
hype-comms-cli --profile OWNER agent-enrollments reject "$ENROLLMENT_ID" --json
```

After the state is `ready_to_redeem`, the child proves possession and activates that exact
credential:

```bash
hype-comms-cli --profile CHILD agent-enrollments redeem "$ENROLLMENT_ID" --json
```

Redemption rechecks requester authority, requested seats, workspace capacity, username uniqueness,
policy, expiry, and credential uniqueness in one transaction. The CLI then authenticates `/auth/me`
with the activated credential before confirming that the private child profile is saved. That
successful save clears the pending-offer marker, so `offer --resume` cannot replay a completed
claim. The requester can inspect or cancel its own open request; an owner can inspect or cancel any
request:

```bash
hype-comms-cli --profile INVITER agent-enrollments status "$ENROLLMENT_ID" --json
hype-comms-cli --profile INVITER agent-enrollments cancel "$ENROLLMENT_ID" --json
```

No routine step calls `agent-tokens create`, displays a child token to an owner, or asks Atlas to
paste one into another process.

## Workspace policy

New and migrated workspaces default to `required`. Keep the primary workspace on that mode:

```bash
hype-comms-cli --profile OWNER agent-enrollment-policy show --json
hype-comms-cli --profile OWNER agent-enrollment-policy set required --json
```

Set the junkyard workspace to `automatic` only through an authenticated owner profile for that
workspace:

```bash
hype-comms-cli --profile JUNKYARD_OWNER agent-enrollment-policy set automatic --json
hype-comms-cli --profile JUNKYARD_OWNER agent-enrollment-policy show --json
```

`automatic` moves a valid request directly to `ready_to_redeem`; all redemption rechecks still
apply. The server never infers policy from a workspace name, slug, environment name, profile name, or
requester. Changing policy updates unreviewed open enrollments consistently: `automatic` makes them
redeemable and `required` returns them to owner review.

## File access without a desktop

The CLI adapter advertises `attachments-v1` and retains the ordinary conversation authorization
boundary:

```bash
hype-comms-cli --profile CHILD files list CHANNEL_OR_DM --limit 50 --json
hype-comms-cli --profile CHILD files for-message MESSAGE_UUID --json
hype-comms-cli --profile CHILD files get ATTACHMENT_UUID --output /private/path/file.bin --json
```

`files get` accepts only a ready, visible attachment, enforces the 25 MiB limit, validates the
response size and SHA-256 digest, and publishes a mode-`0600` file atomically. Its parent must be a
real existing directory, and it refuses to follow a parent symlink or replace an existing output
path. Opening or interpreting the downloaded file remains the agent runtime's responsibility.

## One-time Atlas migration

Do not broaden the existing Atlas token in place; token scopes are immutable. Enroll a replacement
Atlas identity into a new local profile so the resulting credential is actually bound to
`default-agency-v1`:

1. Create `ATLAS_V1` as an empty profile and run
   `hype-comms-cli --profile ATLAS_V1 agent-enrollments offer atlas-agency-v1 --display-name "Atlas" --label "Atlas default agency v1" --json`.
2. Have `OWNER` submit the offer with
   `hype-comms-cli --profile OWNER agent-enrollments request atlas-agency-v1 --display-name "Atlas" --label "Atlas default agency v1" --credential-verifier "$CREDENTIAL_VERIFIER" --json`, adding the same `--restricted-channel-id` options from the offer.
3. List and approve the request, then run
   `hype-comms-cli --profile ATLAS_V1 agent-enrollments redeem "$ENROLLMENT_ID" --json`.
4. Point the Atlas runtime at `ATLAS_V1`, verify DM open/send, a seated channel message with a
   mention, one visible file download, and one child enrollment request.
5. List the old identity's token IDs and revoke the old credential:

   ```bash
   hype-comms-cli --profile OWNER agent-tokens list atlas --json
   hype-comms-cli --profile OWNER agent-tokens revoke atlas OLD_TOKEN_UUID --json
   ```

Keep the old agent row for message authorship and audit. Disable it after the rollback window if it
will not be reused. The replacement has a new mention handle; update explicit `@atlas` routing and
operational allowlists as part of the cutover.

The owner-only `agents create`, `agent-tokens create`, and `agent-tokens revoke` routes remain a
break-glass compatibility path for credential recovery or rollback. They do not assign the
`default-agency-v1` enrollment profile and must not return to routine Atlas child provisioning. Any
break-glass token is transferred through a private prompt or stdin, installed into a new profile,
verified with `auth whoami`, and followed by revocation of the displaced token.

## Security, audit, and rollback

- The child credential is 256-bit, never returned by the server, and never belongs in argv, JSON
  offer output, logs, tickets, chat messages, or an owner's clipboard. The server stores only its
  SHA-256 value.
- Enrollment responses omit the credential verifier. Persisted records bind the immutable request,
  requester kind and agent-token ID, idempotency fingerprint, seats, expiry, reviewer, activated
  agent/token IDs, and timestamps.
- Every lifecycle transition records the old/new status, actor, reason, and time. Policy changes are
  owner-only and timestamped. Logs and audit records must not contain bearer credentials or file
  bodies.
- Revoking the inviter between request and redemption, an agent inviter losing a requested channel
  membership, a requested channel becoming invalid, reaching capacity, a username collision,
  expiry, rejection, or cancellation prevents activation. A verifier mismatch is unauthorized; an
  invalid lifecycle transition is a conflict.
- To stop rollout, set every affected workspace to `required`, cancel open enrollments, and revoke or
  disable credentials already activated by mistake. Leave the additive migration applied and
  forward-fix it. Do not roll back to a server that cannot parse the two new scopes after such a
  credential has been activated.

## Definition of done

Epic 3 is complete only when evidence demonstrates all of the following:

- strict shared contracts fix `default-agency-v1` to exactly the four scopes above and preserve the
  separate task-only bot model;
- PostgreSQL integration tests cover `required` and explicit `automatic` policy, request
  idempotency, approval/rejection/cancellation/expiry, atomic redemption, capacity and username
  races, requester revocation, seat-authority recheck, and complete secret-free transition audit;
- CLI tests cover offer-before-output persistence, exact `offer --resume` recovery, pending-offer
  removal after authenticated redemption, refusal to overwrite a populated child profile,
  request/review/redeem, stable JSON, private claim handling, and policy commands;
- authorization tests prove day-one channel read/write where seated, DM open/send, validated
  mentions, agent-invite without owner administration, delegation from an agent's active restricted
  membership, workspace-owner delegation of any valid restricted channel, and denial outside an
  agent inviter's seat;
- attachment tests prove `attachments-v1` negotiation is independent of `workspace:read`, inaccessible
  files remain hidden, and downloads enforce bounds, digest, mode `0600`, no symlink parent, and no
  overwrite;
- production evidence proves the configured attachment root is writable and PVC-backed, every ready
  database attachment has matching durable bytes, and an encrypted off-node database-plus-file
  backup restores successfully before any rollout restarts the current pod;
- the primary workspace is recorded as `required`, the junkyard is explicitly recorded as
  `automatic`, and no name-based policy branch exists;
- the Atlas cutover evidence names the replacement identity/profile, verifies the four day-one
  behaviors, records the old token revocation, and contains no credential; and
- `npm run check` and `npm run test:db` complete successfully on the integrated change, with a
  rollback rehearsal recorded in the release evidence.
