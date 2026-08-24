import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { encodeAgentWakeKeyInput } from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import type { StoredAgentWakeEnrollment } from "./agent-wake-broker";
import {
  AGENT_WAKE_STORE_MAX_BYTES,
  AgentWakeFileStore,
  AgentWakeFileStoreError,
} from "./agent-wake-file-store";

const ENROLLMENT_ID = "grok-bot-pilot";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const EVENT_ID = "10000000-0000-4000-8000-000000000005";

function wakeId(): string {
  return createHash("sha256")
    .update(
      encodeAgentWakeKeyInput({
        version: 1,
        workspaceId: WORKSPACE_ID,
        agentUserId: AGENT_USER_ID,
        messageId: MESSAGE_ID,
      }),
      "utf8",
    )
    .digest("hex");
}

function state(revision = 1): StoredAgentWakeEnrollment {
  return {
    version: 1,
    revision,
    enrollmentId: ENROLLMENT_ID,
    identity: {
      apiOrigin: "https://chat.example.test",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
    },
    credentialHandle: "hype-cli-grok-bot-pilot",
    provider: { adapterId: "agent-runtime-test", targetHandle: "agent-runtime-primary" },
    cursor: "8",
    runState: "stopped",
    queue: [
      {
        wake: {
          version: 1,
          type: "agent.wake",
          delivery: "at_least_once",
          wakeId: wakeId(),
          eventId: EVENT_ID,
          workspaceSequence: "8",
          workspaceId: WORKSPACE_ID,
          agentUserId: AGENT_USER_ID,
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          threadRootId: null,
          occurredAt: "2026-08-23T18:00:00.000Z",
          reason: "direct_message",
        },
        sourceCursor: "8",
        enqueuedAt: 1_777_000_000_000,
        phase: "queued",
        attempts: 0,
        nextAttemptAt: null,
        lastRetryCode: null,
      },
    ],
    completions: [],
    operatorActions: [],
    repair: null,
    sourceRetry: null,
  };
}

function storedFile(userDataPath: string, enrollmentId = ENROLLMENT_ID): string {
  const key = createHash("sha256").update(enrollmentId, "utf8").digest("hex");
  return path.join(userDataPath, "agent-wake", `${key}.json`);
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "hype-comms-agent-wake-store-"));
}

describe("AgentWakeFileStore", () => {
  it("atomically persists and restores a strict private body-free inbox", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });

    await expect(
      store.transaction(ENROLLMENT_ID, (current) => ({
        state: state(),
        result: current,
      })),
    ).resolves.toBeNull();
    await expect(store.read(ENROLLMENT_ID)).resolves.toEqual(state());

    const file = storedFile(userDataPath);
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const source = await readFile(file, "utf8");
    expect(source).not.toContain("body");
    expect(source).not.toContain("token");
    expect(source).not.toContain("prompt");
  });

  it("migrates a pre-dual-repair record to an explicit empty deferred source repair", async () => {
    const userDataPath = await temporaryDirectory();
    const directory = path.join(userDataPath, "agent-wake");
    const file = storedFile(userDataPath);
    const queued = state().queue[0]!;
    const legacyState = {
      ...state(),
      queue: [{ ...queued, phase: "blocked", attempts: 1 }],
      repair: {
        code: "provider-outcome-ambiguous",
        wakeId: queued.wake.wakeId,
        occurredAt: queued.enqueuedAt,
      },
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(legacyState)}\n`, { mode: 0o600 });

    const store = new AgentWakeFileStore({ userDataPath });
    await expect(store.read(ENROLLMENT_ID)).resolves.toMatchObject({
      repair: {
        code: "provider-outcome-ambiguous",
        deferredSourceRepair: null,
      },
    });
  });

  it("serializes transactions for an enrollment while allowing durable revision updates", async () => {
    const userDataPath = await temporaryDirectory();
    let releaseFirstSync: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    let syncCalls = 0;
    const syncDirectory = vi.fn(async () => {
      syncCalls += 1;
      if (syncCalls === 1) await firstSync;
    });
    const store = new AgentWakeFileStore({ userDataPath, syncDirectory });
    const observations: number[] = [];

    const first = store.transaction(ENROLLMENT_ID, (current) => {
      observations.push(current?.revision ?? 0);
      return { state: state(1), result: "first" };
    });
    await vi.waitFor(() => expect(syncDirectory).toHaveBeenCalledTimes(1));
    const second = store.transaction(ENROLLMENT_ID, (current) => {
      observations.push(current?.revision ?? 0);
      return { state: state(2), result: "second" };
    });
    await Promise.resolve();
    expect(observations).toEqual([0]);

    releaseFirstSync?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(observations).toEqual([0, 1]);
    await expect(store.read(ENROLLMENT_ID)).resolves.toMatchObject({ revision: 2 });
  });

  it("rejects extra sensitive fields, key mismatches, and malformed wake IDs before commit", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });
    await store.transaction(ENROLLMENT_ID, () => ({ state: state(), result: undefined }));
    const queued = state(2).queue[0]!;
    const mismatchedWakeId = `${queued.wake.wakeId.startsWith("a") ? "b" : "a"}${queued.wake.wakeId.slice(1)}`;

    for (const invalid of [
      { ...state(2), token: "secret" },
      { ...state(2), enrollmentId: "another-enrollment" },
      {
        ...state(2),
        identity: { ...state(2).identity, apiOrigin: "http://internal.example.test" },
      },
      {
        ...state(2),
        queue: [
          {
            ...state(2).queue[0]!,
            wake: { ...state(2).queue[0]!.wake, body: "private message", wakeId: "a".repeat(64) },
          },
        ],
      },
      {
        ...state(2),
        queue: [],
        completions: [
          {
            wakeId: mismatchedWakeId,
            conversationId: queued.wake.conversationId,
            messageId: queued.wake.messageId,
            reason: queued.wake.reason,
            occurredAt: queued.wake.occurredAt,
            sourceCursor: queued.sourceCursor,
            attempt: 1,
            brokerDurableAt: queued.enqueuedAt,
            disposition: "accepted",
            providerReceiptId: "receipt-1",
            completedAt: queued.enqueuedAt,
          },
        ],
      },
      {
        ...state(2),
        operatorActions: [
          {
            actionId: "a".repeat(64),
            action: "resume",
            repairCode: null,
            repairOccurredAt: null,
            wakeId: null,
            evidenceReference: "bad\nreference",
            occurredAt: queued.enqueuedAt,
          },
        ],
      },
    ]) {
      await expect(
        store.transaction(ENROLLMENT_ID, () => ({
          state: invalid as StoredAgentWakeEnrollment,
          result: undefined,
        })),
      ).rejects.toMatchObject({ code: "invalid-state" });
    }
    await expect(store.read(ENROLLMENT_ID)).resolves.toEqual(state());
  });

  it("fails closed for unsafe, corrupt, symlinked, or oversized state files", async () => {
    const userDataPath = await temporaryDirectory();
    const directory = path.join(userDataPath, "agent-wake");
    const file = storedFile(userDataPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, "{}\n", { mode: 0o600 });
    const store = new AgentWakeFileStore({ userDataPath });
    await expect(store.read(ENROLLMENT_ID)).rejects.toBeInstanceOf(AgentWakeFileStoreError);

    await writeFile(file, `${JSON.stringify(state())}\n`, { mode: 0o600 });
    await chmod(file, 0o644);
    if (process.platform !== "win32") {
      await expect(store.read(ENROLLMENT_ID)).rejects.toMatchObject({ code: "invalid-state" });
    }

    await writeFile(file, "x".repeat(AGENT_WAKE_STORE_MAX_BYTES + 1), { mode: 0o600 });
    await chmod(file, 0o600);
    await expect(store.read(ENROLLMENT_ID)).rejects.toMatchObject({ code: "invalid-state" });

    const target = path.join(directory, "target.json");
    await writeFile(target, `${JSON.stringify(state())}\n`, { mode: 0o600 });
    await writeFile(file, "replace", { mode: 0o600 });
    await rm(file);
    await symlink(target, file);
    await expect(store.read(ENROLLMENT_ID)).rejects.toMatchObject({ code: "invalid-state" });
  });

  it("classifies temporary descriptor read failures as retryable store unavailability", async () => {
    const userDataPath = await temporaryDirectory();
    const durableStore = new AgentWakeFileStore({ userDataPath });
    await durableStore.transaction(ENROLLMENT_ID, () => ({ state: state(), result: undefined }));
    const store = new AgentWakeFileStore({
      userDataPath,
      readPrivateFile: vi.fn(async () => ({ status: "unavailable" as const })),
    });

    await expect(store.read(ENROLLMENT_ID)).rejects.toMatchObject({
      code: "store-unavailable",
      retryable: true,
    });
  });

  it("durably removes an enrollment only when a transaction requests deletion", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });
    await store.transaction(ENROLLMENT_ID, () => ({ state: state(), result: undefined }));

    await expect(
      store.transaction(ENROLLMENT_ID, (current) => ({
        state: null,
        result: current?.revision,
      })),
    ).resolves.toBe(1);
    await expect(store.read(ENROLLMENT_ID)).resolves.toBeNull();
  });
});
