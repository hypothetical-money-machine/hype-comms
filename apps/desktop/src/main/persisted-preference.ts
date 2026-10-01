import { reportMainProcessError } from "./main-process-log";
import { notifyStateListeners } from "./state-listeners";

export interface PreferencePersistence<Value> {
  load(): Promise<Value>;
  save(value: Value): Promise<void>;
}

interface PreferenceOptions<Value> {
  readonly name: string;
  readonly persistence: PreferencePersistence<Value>;
  readonly equal: (left: Value, right: Value) => boolean;
  readonly canonicalize: (value: Value) => Value;
  readonly reportListenerError?: ((error: unknown) => void) | undefined;
}

/** A durable preference with no external event source. Accepted writes drain during disposal. */
export class PersistedPreference<Value> {
  readonly #options: PreferenceOptions<Value>;
  readonly #reportListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(value: Value) => void>();
  #state: { readonly value: Value } | null = null;
  #initialization: Promise<Value> | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: PreferenceOptions<Value>) {
    this.#options = options;
    this.#reportListenerError =
      options.reportListenerError ??
      ((error) => reportMainProcessError(`${options.name} listener failed`, error));
  }

  get state(): Value {
    if (this.#state === null)
      throw new Error(`${this.#options.name} must be initialized before its state is read`);
    return this.#state.value;
  }

  initialize(): Promise<Value> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    if (this.#state !== null) return Promise.resolve(this.#state.value);
    if (this.#initialization !== null) return this.#initialization;
    const initialization = this.#initialize();
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) this.#initialization = null;
    });
    return initialization;
  }

  subscribe(listener: (value: Value) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  protected change(updater: (current: Value) => Value): Promise<Value> {
    try {
      this.#assertReady();
      const request = this.#writeTail.then(() => this.#change(updater));
      this.#writeTail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #initialize(): Promise<Value> {
    const value = this.#options.canonicalize(await this.#options.persistence.load());
    if (this.#disposed) throw this.#disposedError();
    this.#state = { value };
    return value;
  }

  async #change(updater: (current: Value) => Value): Promise<Value> {
    const previous = this.state;
    const next = this.#options.canonicalize(updater(previous));
    if (this.#options.equal(previous, next)) return previous;
    await this.#options.persistence.save(next);
    // The next queued patch must see what reached disk, including during shutdown.
    this.#state = { value: next };
    if (this.#disposed) throw this.#disposedError();
    notifyStateListeners(this.#listeners, next, this.#reportListenerError);
    return next;
  }

  #disposedError(): Error {
    return new Error(`${this.#options.name} has been disposed`);
  }

  #assertReady(): void {
    if (this.#disposed) throw this.#disposedError();
    if (this.#state === null)
      throw new Error(`${this.#options.name} must be initialized before use`);
  }
}
