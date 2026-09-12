import { collectionKey, type CollectionIdentity } from "./workspace-collections";

export type WorkspaceRecoveryKind =
  | "startup"
  | "catalog"
  | "members"
  | "membership"
  | "sync"
  | "resync"
  | "retract_metadata"
  | "protocol"
  | "replica";

export interface RecoveryLease {
  readonly key: string;
  readonly owner: symbol;
}

export type StartupPhase = "metadata" | "replica_catch_up" | "realtime";

export interface RecoveryEntry {
  readonly key: string;
  readonly collection: CollectionIdentity | null;
  readonly status: "pending" | "blocked";
  readonly startupPhase: StartupPhase | null;
  readonly reason: string | null;
}

/** A completion can settle only the operation that created its lease. */
export class WorkspaceRecovery {
  readonly #work = new Map<string, { lease: RecoveryLease; entry: RecoveryEntry }>();
  readonly #changed: () => void;
  #snapshot: readonly RecoveryEntry[] = [];

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  get startupPhase(): StartupPhase | null {
    return this.#work.get("startup")?.entry.startupPhase ?? null;
  }

  get snapshot(): readonly RecoveryEntry[] {
    return this.#snapshot;
  }

  current(kind: WorkspaceRecoveryKind): RecoveryLease | undefined {
    return this.#work.get(kind)?.lease;
  }

  has(kind: WorkspaceRecoveryKind): boolean {
    return this.#work.has(kind);
  }

  isCurrent(lease: RecoveryLease | undefined): boolean {
    return lease !== undefined && this.#work.get(lease.key)?.lease === lease;
  }

  begin(kind: WorkspaceRecoveryKind): RecoveryLease {
    return this.#begin(kind, null);
  }

  ensure(kind: WorkspaceRecoveryKind): RecoveryLease {
    return this.current(kind) ?? this.begin(kind);
  }

  beginCollection(identity: CollectionIdentity): RecoveryLease {
    return this.#begin(`collection:${collectionKey(identity)}`, identity);
  }

  #begin(key: string, collection: CollectionIdentity | null): RecoveryLease {
    const lease = { key, owner: Symbol(key) };
    this.#work.set(key, {
      lease,
      entry: {
        key,
        collection,
        status: "pending",
        reason: null,
        startupPhase: key === "startup" ? "metadata" : null,
      },
    });
    this.#publish();
    return lease;
  }

  complete(lease: RecoveryLease | undefined): boolean {
    if (!this.isCurrent(lease) || lease === undefined) return false;
    this.#work.delete(lease.key);
    this.#publish();
    return true;
  }

  block(lease: RecoveryLease | undefined, reason: string): void {
    if (lease === undefined) return;
    const work = this.#work.get(lease.key);
    if (work?.lease !== lease) return;
    this.#work.set(lease.key, {
      lease,
      entry: { ...work.entry, status: "blocked", reason },
    });
    this.#publish();
  }

  advanceStartup(lease: RecoveryLease | undefined, phase: StartupPhase): void {
    if (lease === undefined || lease.key !== "startup") return;
    const work = this.#work.get(lease.key);
    if (work?.lease !== lease) return;
    this.#work.set(lease.key, {
      lease,
      entry: { ...work.entry, startupPhase: phase, status: "pending", reason: null },
    });
    this.#publish();
  }

  /** Only session retirement may discard all outstanding owners. */
  reset(): void {
    this.#work.clear();
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = [...this.#work.values()].map((work) => work.entry);
    this.#changed();
  }
}

export function workspaceNeedsRecovery(entries: readonly RecoveryEntry[]): boolean {
  return entries.some((entry) => entry.collection === null);
}

export function collectionNeedsRecovery(
  entries: readonly RecoveryEntry[],
  identity: CollectionIdentity,
): boolean {
  const key = collectionKey(identity);
  return entries.some(
    (entry) => entry.collection === null || collectionKey(entry.collection) === key,
  );
}

export function collectionRecovery(
  entries: readonly RecoveryEntry[],
  identity: CollectionIdentity,
): RecoveryEntry | undefined {
  const key = collectionKey(identity);
  return entries.find(
    (entry) => entry.collection !== null && collectionKey(entry.collection) === key,
  );
}
