import { parse } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRIVATE_DOWNLOAD_MAX_FAILURE_MESSAGE_LENGTH,
  PRIVATE_DOWNLOAD_MAX_INPUT_BYTES,
  PRIVATE_DOWNLOAD_MAX_SNAPSHOT_COMPONENTS,
  privateDownloadConfigMessageSchema,
  privateDownloadContinuationMessageSchema,
  privateDownloadFailureMessageSchema,
  privateDownloadPhaseMessageSchema,
  privateDownloadSuccessMessageSchema,
} from "../src/private-download-protocol.js";

const validConfigMessage = {
  type: "config",
  config: {
    byteLength: 18,
    directorySnapshot: {
      root: { path: parse(process.cwd()).root, dev: "1", ino: "2" },
      components: [{ name: "downloads", dev: "3", ino: "4" }],
    },
    targetName: "attachment.bin",
    temporaryName: ".hype-comms-download.test.part",
  },
} as const;

describe("private download IPC protocol", () => {
  it("accepts the complete configuration message", () => {
    expect(privateDownloadConfigMessageSchema.parse(validConfigMessage)).toEqual(
      validConfigMessage,
    );
  });

  it.each([
    { ...validConfigMessage, unexpected: true },
    {
      ...validConfigMessage,
      config: { ...validConfigMessage.config, unexpected: true },
    },
    {
      ...validConfigMessage,
      config: {
        ...validConfigMessage.config,
        directorySnapshot: {
          ...validConfigMessage.config.directorySnapshot,
          unexpected: true,
        },
      },
    },
    {
      ...validConfigMessage,
      config: {
        ...validConfigMessage.config,
        directorySnapshot: {
          ...validConfigMessage.config.directorySnapshot,
          root: {
            ...validConfigMessage.config.directorySnapshot.root,
            unexpected: true,
          },
        },
      },
    },
    {
      ...validConfigMessage,
      config: {
        ...validConfigMessage.config,
        directorySnapshot: {
          ...validConfigMessage.config.directorySnapshot,
          components: [
            { ...validConfigMessage.config.directorySnapshot.components[0], unexpected: true },
          ],
        },
      },
    },
  ])("rejects unknown configuration keys at every object boundary", (message) => {
    expect(privateDownloadConfigMessageSchema.safeParse(message).success).toBe(false);
  });

  it.each([
    [privateDownloadPhaseMessageSchema, { type: "phase", phase: "temporary-ready" }],
    [privateDownloadContinuationMessageSchema, { type: "continue", phase: "target-linked" }],
    [privateDownloadSuccessMessageSchema, { type: "result", ok: true }],
    [
      privateDownloadFailureMessageSchema,
      {
        type: "result",
        ok: false,
        code: "INVALID_OUTPUT_PATH",
        message: "The output directory changed while the file was being saved",
      },
    ],
  ])("accepts an exact %s message and rejects extra keys", (schema, message) => {
    expect(schema.safeParse(message).success).toBe(true);
    expect(schema.safeParse({ ...message, unexpected: true }).success).toBe(false);
  });

  it.each([
    [
      "relative roots",
      {
        ...validConfigMessage,
        config: {
          ...validConfigMessage.config,
          directorySnapshot: {
            ...validConfigMessage.config.directorySnapshot,
            root: { ...validConfigMessage.config.directorySnapshot.root, path: "relative" },
          },
        },
      },
    ],
    [
      "path-like target names",
      {
        ...validConfigMessage,
        config: { ...validConfigMessage.config, targetName: "../attachment.bin" },
      },
    ],
    [
      "unsafe byte counts",
      {
        ...validConfigMessage,
        config: { ...validConfigMessage.config, byteLength: Number.MAX_SAFE_INTEGER + 1 },
      },
    ],
    [
      "non-canonical inode identities",
      {
        ...validConfigMessage,
        config: {
          ...validConfigMessage.config,
          directorySnapshot: {
            ...validConfigMessage.config.directorySnapshot,
            root: { ...validConfigMessage.config.directorySnapshot.root, ino: "01" },
          },
        },
      },
    ],
  ])("rejects %s", (_label, message) => {
    expect(privateDownloadConfigMessageSchema.safeParse(message).success).toBe(false);
  });

  it("enforces the protocol's input, snapshot, and failure-message bounds", () => {
    expect(
      privateDownloadConfigMessageSchema.safeParse({
        ...validConfigMessage,
        config: {
          ...validConfigMessage.config,
          byteLength: PRIVATE_DOWNLOAD_MAX_INPUT_BYTES + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      privateDownloadConfigMessageSchema.safeParse({
        ...validConfigMessage,
        config: {
          ...validConfigMessage.config,
          directorySnapshot: {
            ...validConfigMessage.config.directorySnapshot,
            components: Array.from(
              { length: PRIVATE_DOWNLOAD_MAX_SNAPSHOT_COMPONENTS + 1 },
              () => validConfigMessage.config.directorySnapshot.components[0],
            ),
          },
        },
      }).success,
    ).toBe(false);
    expect(
      privateDownloadFailureMessageSchema.safeParse({
        type: "result",
        ok: false,
        code: "WORKER_FAILURE",
        message: "x".repeat(PRIVATE_DOWNLOAD_MAX_FAILURE_MESSAGE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
