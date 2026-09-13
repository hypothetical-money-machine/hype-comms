export interface WorkspaceSessionIdentity {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface WorkspaceSessionScope extends WorkspaceSessionIdentity {
  readonly generation: number;
}

type DisposeResource = () => void | Promise<unknown>;

/** One identity's resources. Cancelling a scope never deletes credentials, keys, or local work. */
export class OwnedWorkspaceSession<Resources extends object> {
  readonly #abort = new AbortController();
  readonly #cleanup: DisposeResource[] = [];
  #resources: Resources | null = null;
  #disposal: Promise<void> | null = null;

  constructor(readonly scope: WorkspaceSessionScope) {}

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get resources(): Resources {
    this.assertActive();
    if (this.#resources === null) throw new Error("Workspace session is not initialized");
    return this.#resources;
  }

  initialize(create: (session: OwnedWorkspaceSession<Resources>) => Resources): void {
    this.assertActive();
    if (this.#resources !== null) throw new Error("Workspace session is already initialized");
    this.#resources = create(this);
  }

  onDispose(cleanup: DisposeResource): void {
    this.assertActive();
    this.#cleanup.push(cleanup);
  }

  assertActive(): void {
    this.signal.throwIfAborted();
  }

  async run<T>(operation: (resources: Resources) => Promise<T> | T): Promise<T> {
    const result = await operation(this.resources);
    this.assertActive();
    return result;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    let resolve: () => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    this.#disposal = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.#abort.abort(new DOMException("Workspace session was replaced", "AbortError"));
    // Start every cleanup now, even if an earlier resource throws or needs asynchronous teardown.
    const pending = this.#cleanup
      .splice(0)
      .reverse()
      .map((cleanup) => {
        try {
          return Promise.resolve(cleanup());
        } catch (error) {
          return Promise.reject(error);
        }
      });
    void Promise.allSettled(pending).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        reject(new AggregateError(failures, "Workspace session cleanup failed"));
      else resolve();
    });
    return this.#disposal;
  }
}

function sameIdentity(
  left: WorkspaceSessionIdentity | null,
  right: WorkspaceSessionIdentity | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.userId === right.userId && left.workspaceId === right.workspaceId;
}

/** Serializes resource replacement while cancelling the retiring scope synchronously. */
export class WorkspaceSessionOwner<Resources extends object> {
  #current: OwnedWorkspaceSession<Resources> | null = null;
  #desired: WorkspaceSessionIdentity | null = null;
  #revision = 0;
  #pending = false;
  #ready: Promise<void> = Promise.resolve();
  #disposal: Promise<void> | null = null;

  constructor(readonly create: (session: OwnedWorkspaceSession<Resources>) => Resources) {}

  get current(): OwnedWorkspaceSession<Resources> | null {
    return this.#current;
  }

  get ready(): Promise<void> {
    return this.#ready;
  }

  replace(identity: WorkspaceSessionIdentity | null): Promise<void> {
    if (this.#disposal !== null)
      return Promise.reject(new Error("Workspace session owner is disposed"));
    if (
      sameIdentity(identity, this.#desired) &&
      (this.#pending || this.#current !== null || identity === null)
    ) {
      return this.#ready;
    }
    if (this.#revision >= Number.MAX_SAFE_INTEGER)
      throw new Error("Workspace session generation is exhausted");
    const revision = ++this.#revision;
    this.#desired = identity;
    const previous = this.#current;
    this.#current = null;
    const retirement = previous?.dispose();
    // A previous transition may still be settling before this one can await retirement.
    void retirement?.catch(() => undefined);
    this.#pending = true;
    const transition = this.#ready
      .catch(() => undefined)
      .then(async () => {
        await retirement;
        if (revision !== this.#revision || identity === null) return;
        const session = new OwnedWorkspaceSession<Resources>(
          Object.freeze({ ...identity, generation: revision }),
        );
        try {
          session.initialize(this.create);
          if (revision !== this.#revision || this.#disposal !== null) {
            await session.dispose();
            return;
          }
          this.#current = session;
        } catch (error) {
          try {
            await session.dispose();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Workspace session initialization failed",
              { cause: cleanupError },
            );
          }
          throw error;
        }
      });
    this.#ready = transition.finally(() => {
      if (revision === this.#revision) this.#pending = false;
    });
    return this.#ready;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposal = this.replace(null);
    return this.#disposal;
  }
}
