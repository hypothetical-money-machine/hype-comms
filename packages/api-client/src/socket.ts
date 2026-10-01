import { REALTIME_FRAME_MAX_BYTES } from "./limits.js";

export type RealtimeData = string | ArrayBuffer | ArrayBufferView | readonly Uint8Array[];

/** Transport port. A WebSocket adapter supplies framing events and close/send operations. */
export interface RealtimeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "message", listener: (data: RealtimeData, isBinary: boolean) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "open", listener: () => void): unknown;
  once(event: "close", listener: (code: number) => void): unknown;
  once(
    event: "unexpected-response",
    listener: (
      request: unknown,
      response: {
        readonly headers: Readonly<Record<string, string | string[] | undefined>>;
        readonly statusCode?: number | undefined;
        destroy(): unknown;
      },
    ) => void,
  ): unknown;
  close(code?: number, reason?: string): void;
  terminate(): void;
  send(data: string): void;
}

export function decodeRealtimeData(
  data: RealtimeData,
  isBinary: boolean,
): { readonly value: unknown; readonly frameBytes: number } {
  if (isBinary) throw new Error("Realtime frames must be text");
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data))
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else {
    const size = data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (size > REALTIME_FRAME_MAX_BYTES) throw new Error("Realtime frame exceeded its byte limit");
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of data) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  if (bytes.byteLength > REALTIME_FRAME_MAX_BYTES)
    throw new Error("Realtime frame exceeded its byte limit");
  return {
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    frameBytes: bytes.byteLength,
  };
}
