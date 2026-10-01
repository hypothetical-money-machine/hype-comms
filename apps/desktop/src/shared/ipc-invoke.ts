import {
  DESKTOP_INVOKE_CONTRACTS,
  type DesktopInvokeArguments,
  type DesktopInvokeInput,
  type DesktopInvokeName,
  type DesktopInvokeResult,
} from "./ipc-invoke-contract";

export interface IpcPayloadSchema<T> {
  readonly parse: (value: unknown) => T;
}

export function parseBoundedIpcPayload<T>(
  schema: IpcPayloadSchema<T>,
  value: unknown,
  maxBytes: number,
): T {
  // Void replies are valid IPC values. Every other reply and all argument tuples are JSON.
  if (value === undefined) return schema.parse(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("IPC payload must be JSON-serializable");
  }
  if (serialized === undefined) throw new TypeError("IPC payload must be JSON-serializable");
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError("IPC payload exceeds its byte limit");
  }
  return schema.parse(value);
}

export function parseInvokeArguments<K extends DesktopInvokeName>(
  name: K,
  args: unknown,
): DesktopInvokeArguments<K> {
  const contract = DESKTOP_INVOKE_CONTRACTS[name];
  // TypeScript loses the key/schema correlation when indexing a heterogeneous table. The parser
  // selected by this same key is the runtime authority for this assertion.
  return parseBoundedIpcPayload<unknown>(
    contract.request,
    args,
    contract.requestMaxBytes,
  ) as DesktopInvokeArguments<K>;
}

export function parseInvokeResult<K extends DesktopInvokeName>(
  name: K,
  result: unknown,
): DesktopInvokeResult<K> {
  const contract = DESKTOP_INVOKE_CONTRACTS[name];
  return parseBoundedIpcPayload<unknown>(
    contract.response,
    result,
    contract.responseMaxBytes,
  ) as DesktopInvokeResult<K>;
}

export interface IpcInvoker {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export function createDesktopInvoker(ipc: IpcInvoker) {
  return async <K extends DesktopInvokeName>(
    name: K,
    ...input: DesktopInvokeInput<K>
  ): Promise<DesktopInvokeResult<K>> => {
    const args = parseInvokeArguments(name, input);
    const result = await ipc.invoke(DESKTOP_INVOKE_CONTRACTS[name].channel, ...args);
    return parseInvokeResult(name, result);
  };
}
