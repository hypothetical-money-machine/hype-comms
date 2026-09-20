import {
  DESKTOP_INVOKE_CONTRACTS,
  type DesktopInvokeContext,
  type DesktopInvokeHandlers,
  type DesktopInvokeName,
} from "../shared/ipc-invoke-contract";
import { parseInvokeArguments, parseInvokeResult } from "../shared/ipc-invoke";

export interface IpcInvokeRegistry<Event> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

// A disposer from a replaced registration must never remove its successor's handlers.
const registrations = new WeakMap<object, Map<string, symbol>>();

export function registerDesktopInvokes<Event>(
  ipc: IpcInvokeRegistry<Event>,
  authorize: (event: Event) => DesktopInvokeContext | null,
  handlers: DesktopInvokeHandlers,
): () => void {
  let owners = registrations.get(ipc);
  if (owners === undefined) {
    owners = new Map();
    registrations.set(ipc, owners);
  }
  const ownership = owners;
  const owner = Symbol("desktop IPC registration");
  const installed: string[] = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const channel of installed) {
      if (ownership.get(channel) !== owner) continue;
      ipc.removeHandler(channel);
      ownership.delete(channel);
    }
  };

  const register = <K extends DesktopInvokeName>(name: K): void => {
    const { channel } = DESKTOP_INVOKE_CONTRACTS[name];
    ipc.removeHandler(channel);
    // Invalidate an old handler even if the replacement fails to install.
    ownership.delete(channel);
    ipc.handle(channel, async (event, ...input) => {
      const isCurrent = (): boolean => !disposed && ownership.get(channel) === owner;
      if (!isCurrent()) throw new Error("Desktop IPC registration was disposed");
      const context = authorize(event);
      if (context === null) throw new Error("Untrusted desktop IPC sender");
      const args = parseInvokeArguments(name, input);
      const result = await handlers[name](context, ...args);
      if (!isCurrent()) throw new Error("Desktop IPC registration was disposed");
      return parseInvokeResult(name, result);
    });
    ownership.set(channel, owner);
    installed.push(channel);
  };

  try {
    for (const name of Object.keys(DESKTOP_INVOKE_CONTRACTS) as DesktopInvokeName[]) {
      register(name);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
