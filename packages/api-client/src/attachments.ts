import { ATTACHMENT_CONTENT_SHA256_HEADER, ATTACHMENT_MAX_BYTES } from "@hype-comms/contracts";
import { ApiClientError, cancelResponse } from "./errors.js";
import { readResponseBytes } from "./body.js";
import type { HttpClient, RawRequestOptions } from "./http.js";

export interface DownloadRequestOptions extends Omit<RawRequestOptions, "body" | "method"> {
  readonly maxBytes: number;
}
export interface DownloadResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sizeBytes: number;
  readonly contentSha256: string;
  readonly response: Response;
}

export type Sha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
export const sha256: Sha256 = async (bytes) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export class AttachmentClient {
  constructor(
    private readonly http: HttpClient,
    private readonly digest: Sha256 = sha256,
  ) {}

  async download(options: DownloadRequestOptions): Promise<DownloadResult> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error("Download limits must be positive safe integers");
    const { response, signal } = await this.http.open({
      ...options,
      headers: {
        accept: "application/octet-stream",
        ...options.headers,
        "accept-encoding": "identity",
      },
    });
    const reject = async (message: string): Promise<never> => {
      await cancelResponse(response);
      throw new ApiClientError("contract", message, response);
    };
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity")
      return reject("The attachment response used an unsupported content encoding");
    const length = response.headers.get("content-length");
    if (length === null || !/^(?:0|[1-9]\d*)$/u.test(length))
      return reject("The attachment response did not include a valid Content-Length");
    const expected = Number(length);
    if (
      !Number.isSafeInteger(expected) ||
      expected > Math.min(options.maxBytes, ATTACHMENT_MAX_BYTES)
    )
      return reject("The attachment response exceeded the supported size limit");
    const expectedDigest = response.headers.get(ATTACHMENT_CONTENT_SHA256_HEADER);
    if (expectedDigest === null || !/^[a-f0-9]{64}$/u.test(expectedDigest))
      return reject("The attachment response did not include a valid SHA-256 digest");
    const bytes = await readResponseBytes(response, expected, signal);
    if (bytes.byteLength !== expected)
      throw new ApiClientError(
        "contract",
        "The attachment response length did not match its metadata",
        response,
      );
    const contentSha256 = await this.digest(bytes);
    if (contentSha256 !== expectedDigest)
      throw new ApiClientError(
        "contract",
        "The attachment response digest did not match its metadata",
        response,
      );
    return { bytes, sizeBytes: bytes.byteLength, contentSha256, response };
  }

  async upload(
    options: Omit<RawRequestOptions, "body" | "method"> & { readonly bytes: Uint8Array },
  ): Promise<Response> {
    if (options.bytes.byteLength < 1 || options.bytes.byteLength > ATTACHMENT_MAX_BYTES)
      throw new ApiClientError("request", "The attachment exceeded the supported size limit");
    const { response } = await this.http.open({
      ...options,
      method: "PUT",
      body: new Uint8Array(options.bytes),
    });
    await cancelResponse(response);
    return response;
  }
}
