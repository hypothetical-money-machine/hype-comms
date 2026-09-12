import { DESKTOP_INITIAL_CHANNELS } from "../shared/channels";
import type { DesktopInitialValues } from "../shared/ipc-initial-values";

interface InitialValueEvent {
  returnValue: unknown;
}

export interface IpcInitialValueRegistry {
  on(channel: string, listener: (event: InitialValueEvent) => void): unknown;
  removeListener(channel: string, listener: (event: InitialValueEvent) => void): unknown;
}

const disposers = new WeakMap<object, () => void>();

export function registerDesktopInitialValues(
  ipc: IpcInitialValueRegistry,
  getValues: () => DesktopInitialValues,
): () => void {
  disposers.get(ipc)?.();
  const listener = (event: InitialValueEvent): void => {
    event.returnValue = getValues().automationHeadless;
  };
  ipc.on(DESKTOP_INITIAL_CHANNELS.automationHeadless, listener);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    ipc.removeListener(DESKTOP_INITIAL_CHANNELS.automationHeadless, listener);
    if (disposers.get(ipc) === dispose) disposers.delete(ipc);
  };
  disposers.set(ipc, dispose);
  return dispose;
}
