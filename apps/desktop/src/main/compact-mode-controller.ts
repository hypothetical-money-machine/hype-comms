import { PersistedPreference, type PreferencePersistence } from "./persisted-preference";

export type CompactModePersistence = PreferencePersistence<boolean>;

export class CompactModeController extends PersistedPreference<boolean> {
  constructor(options: {
    readonly persistence: CompactModePersistence;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    super({
      ...options,
      name: "CompactModeController",
      canonicalize: (value) => value,
      equal: (left, right) => left === right,
    });
  }

  get enabled(): boolean {
    return this.state;
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    return this.change(() => enabled);
  }
}
