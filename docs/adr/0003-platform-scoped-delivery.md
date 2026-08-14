# 3. Platform-scoped feature delivery and rollout

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

Hype Comms supports macOS, Windows, and Linux, and release workflows exercise all three. Existing
documentation sometimes described a complete native matrix as one feature gate. Agents and
contributors could therefore infer that no platform-specific work was actionable until equivalent
behavior and evidence existed everywhere.

That inference prevents useful increments and conflates three different concerns: preserving
supported clients, deciding a feature's product scope, and proving a particular native artifact.
Some capabilities are inherently platform-specific, and the two-person pilot may benefit from one
platform before equivalent work on another is worthwhile.

## Decision

Feature scope is platform-specific by default. An issue, change, or rollout may target one desktop
platform or a stated subset. Missing implementations for other platforms are follow-up work, not
implicit acceptance criteria or blockers.

Every partial delivery must:

- preserve the established behavior of untargeted platforms;
- keep shared schemas and persisted data backward compatible unless an explicit coordinated
  migration says otherwise;
- use capability detection, platform conditions, or default-off gates when an unavailable feature
  would otherwise be exposed; and
- state its platform scope and test the applicable supported architectures and package formats.

Cross-platform parity is a joint gate only when an issue or product decision explicitly requires
it, or when a shared security, authorization, data-loss, migration, wire-compatibility, or release
safety invariant makes independent delivery unsafe. The repository-wide release matrix still
verifies every supported artifact, but each artifact is tested against its intended behavior; the
matrix does not expand every feature's scope.

Native-notification Milestone 4 follows this rule. macOS, Windows, and Linux each have an installed
evidence lane covering every cell of that platform's row in the supported host matrix in
[`docs/architecture.md`](../architecture.md#supported-host-matrix), which stays the single
definition of a platform's baseline.
A platform may enable an evidence or opt-in pilot build before its lane passes while keeping the
platform default-off. The device default may change only after the lane passes; an incomplete lane
remains visible on the roadmap but does not block a proven platform.
A shared defect may still pause multiple lanes when it violates one of the invariants above.

## Consequences

- Platform-specific improvements can be designed, merged, and released independently.
- Product and release notes must be candid about where a capability is available.
- Follow-up parity work remains trackable without being mislabeled as a dependency.
- Full-matrix release health and baseline platform support remain required even when optional
  feature sets differ.
