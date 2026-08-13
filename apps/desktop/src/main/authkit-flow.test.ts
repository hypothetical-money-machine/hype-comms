import { createHash } from "node:crypto";

import type {
  CreateDesktopAuthorizationRequest,
  DesktopAuthCallbackParameters,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthKitAuthorizationExpiredError,
  AuthKitAuthorizationUrlError,
  AuthKitFlow,
  type AuthKitAuthorizationApi,
  type AuthKitPendingAuthorizationStore,
  type StoredAuthKitPendingAuthorization,
} from "./authkit-flow";

const NOW = new Date("2026-08-11T18:00:00.000Z");
const API_ORIGIN = "https://chat-api.example.invalid";
const HANDOFF_CODE = "h".repeat(43);

class MemoryPendingStore implements AuthKitPendingAuthorizationStore {
  pending: StoredAuthKitPendingAuthorization | null = null;
  readonly operations: string[] = [];
  clearError: Error | null = null;
  loadError: Error | null = null;
  saveError: Error | null = null;

  async load(): Promise<StoredAuthKitPendingAuthorization | null> {
    this.operations.push("load");
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.pending;
  }

  async save(pending: StoredAuthKitPendingAuthorization): Promise<void> {
    this.operations.push("save");
    if (this.saveError !== null) {
      throw this.saveError;
    }
    this.pending = pending;
  }

  async clear(): Promise<void> {
    this.operations.push("clear");
    if (this.clearError !== null) {
      throw this.clearError;
    }
    this.pending = null;
  }
}

function authorizationApi(
  beginDesktopAuthorization: AuthKitAuthorizationApi["beginDesktopAuthorization"] = async () => ({
    authorizationUrl: "https://example.authkit.app/authorize",
  }),
): AuthKitAuthorizationApi {
  return { beginDesktopAuthorization };
}

function createFlow(
  options: {
    readonly api?: AuthKitAuthorizationApi;
    readonly now?: () => Date;
    readonly openExternal?: (url: string) => Promise<void>;
    readonly store?: MemoryPendingStore;
  } = {},
): { readonly flow: AuthKitFlow; readonly store: MemoryPendingStore } {
  const store = options.store ?? new MemoryPendingStore();
  return {
    flow: new AuthKitFlow({
      api: options.api ?? authorizationApi(),
      apiOrigin: API_ORIGIN,
      now: options.now ?? (() => NOW),
      openExternal: options.openExternal ?? (async () => undefined),
      store,
    }),
    store,
  };
}

function storedPending(
  state = "s".repeat(43),
  createdAt = NOW,
  expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1_000),
): StoredAuthKitPendingAuthorization {
  return {
    version: 1,
    apiOrigin: API_ORIGIN,
    state,
    codeVerifier: "v".repeat(43),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthKitFlow", () => {
  it("persists 32-byte desktop state and PKCE material before requesting authorization", async () => {
    const store = new MemoryPendingStore();
    const opened: string[] = [];
    const beginDesktopAuthorization = vi.fn(async (request: CreateDesktopAuthorizationRequest) => {
      expect(store.pending).not.toBeNull();
      expect(store.operations).toEqual(["load", "save"]);
      expect(request.state).toBe(store.pending?.state);
      expect(request.codeChallenge).toBe(
        createHash("sha256")
          .update(store.pending?.codeVerifier ?? "", "ascii")
          .digest("base64url"),
      );
      return { authorizationUrl: "https://example.authkit.app/authorize?screen_hint=sign-in" };
    });
    const { flow } = createFlow({
      api: authorizationApi(beginDesktopAuthorization),
      openExternal: async (url) => {
        opened.push(url);
      },
      store,
    });

    const attempt = await flow.start();

    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.pending?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(attempt.state, "base64url")).toHaveLength(32);
    expect(Buffer.from(store.pending?.codeVerifier ?? "", "base64url")).toHaveLength(32);
    expect(opened).toEqual(["https://example.authkit.app/authorize?screen_hint=sign-in"]);
    flow.dispose();
  });

  it.each([
    "http://example.authkit.app/authorize",
    "https://user:secret@example.authkit.app/authorize",
    "javascript:alert(1)",
  ])("does not open an unsafe authorization URL: %s", async (authorizationUrl) => {
    const openExternal = vi.fn(async () => undefined);
    const { flow, store } = createFlow({
      api: authorizationApi(async () => ({ authorizationUrl })),
      openExternal,
    });

    await expect(flow.start()).rejects.toBeInstanceOf(AuthKitAuthorizationUrlError);
    expect(openExternal).not.toHaveBeenCalled();
    expect(store.pending).toBeNull();
    expect(store.operations).toEqual(["load", "save", "clear"]);
    flow.dispose();
  });

  it("does not request authorization when protected persistence fails", async () => {
    const store = new MemoryPendingStore();
    store.saveError = new Error("credential store locked");
    const beginDesktopAuthorization = vi.fn(async () => ({
      authorizationUrl: "https://example.authkit.app/authorize",
    }));
    const { flow } = createFlow({
      api: authorizationApi(beginDesktopAuthorization),
      store,
    });

    await expect(flow.start()).rejects.toThrow("credential store locked");
    expect(beginDesktopAuthorization).not.toHaveBeenCalled();
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("does not open a URL returned after the persisted transaction expires", async () => {
    let now = NOW;
    let resolveAuthorization: ((value: { readonly authorizationUrl: string }) => void) | undefined;
    const authorization = new Promise<{ readonly authorizationUrl: string }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const openExternal = vi.fn(async () => undefined);
    const { flow, store } = createFlow({
      api: authorizationApi(() => authorization),
      now: () => now,
      openExternal,
    });

    const start = flow.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    now = new Date(NOW.getTime() + 10 * 60 * 1_000);
    resolveAuthorization?.({ authorizationUrl: "https://example.authkit.app/authorize" });

    await expect(start).rejects.toBeInstanceOf(AuthKitAuthorizationExpiredError);
    expect(openExternal).not.toHaveBeenCalled();
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("ignores unrelated and duplicate callbacks while consuming a matching handoff once", async () => {
    const { flow, store } = createFlow();
    await flow.start();
    const pending = store.pending;
    expect(pending).not.toBeNull();

    await expect(
      flow.handleCallback({ code: "x".repeat(43), state: "z".repeat(43) }),
    ).resolves.toEqual({ status: "ignored" });
    expect(store.pending).toBe(pending);

    const callback: DesktopAuthCallbackParameters = {
      code: HANDOFF_CODE,
      state: pending?.state ?? "",
    };
    const first = await flow.handleCallback(callback);
    expect(first).toEqual({
      status: "handoff",
      handoff: {
        callback,
        codeVerifier: pending?.codeVerifier,
      },
    });
    expect(store.pending).toBeNull();
    await expect(flow.handleCallback(callback)).resolves.toEqual({ status: "ignored" });
    expect(store.operations.filter((operation) => operation === "clear")).toHaveLength(1);
    flow.dispose();
  });

  it("retires a matching generic error without exposing provider details", async () => {
    const { flow, store } = createFlow();
    await flow.start();
    const state = store.pending?.state ?? "";

    await expect(flow.handleCallback({ error: "authentication_failed", state })).resolves.toEqual({
      status: "authentication_failed",
    });
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("retires an expired callback instead of returning a handoff", async () => {
    let now = NOW;
    const store = new MemoryPendingStore();
    store.pending = storedPending();
    const { flow } = createFlow({ now: () => now, store });
    await expect(flow.initialize()).resolves.toEqual({
      status: "pending",
      expiresAt: store.pending?.expiresAt,
    });

    now = new Date(NOW.getTime() + 10 * 60 * 1_000);
    await expect(
      flow.handleCallback({ code: HANDOFF_CODE, state: "s".repeat(43) }),
    ).resolves.toEqual({ status: "expired" });
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("clears an already-expired persisted transaction during initialization", async () => {
    const store = new MemoryPendingStore();
    store.pending = storedPending(
      "s".repeat(43),
      new Date(NOW.getTime() - 11 * 60 * 1_000),
      new Date(NOW.getTime() - 60 * 1_000),
    );
    const { flow } = createFlow({ store });

    await expect(flow.initialize()).resolves.toEqual({ status: "expired" });
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("allows initialization to be retried after protected storage is temporarily unavailable", async () => {
    const store = new MemoryPendingStore();
    store.loadError = new Error("credential store locked");
    const { flow } = createFlow({ store });

    const first = flow.initialize();
    expect(flow.initialize()).toBe(first);
    await expect(first).rejects.toThrow("credential store locked");

    store.loadError = null;
    await expect(flow.initialize()).resolves.toEqual({ status: "idle" });
    expect(store.operations).toEqual(["load", "load"]);
    flow.dispose();
  });

  it("reconciles expiry when an initialized flow is checked after resume", async () => {
    let now = NOW;
    const store = new MemoryPendingStore();
    store.pending = storedPending();
    const { flow } = createFlow({ now: () => now, store });
    await expect(flow.initialize()).resolves.toMatchObject({ status: "pending" });

    now = new Date(NOW.getTime() + 11 * 60 * 1_000);
    await expect(flow.initialize()).resolves.toEqual({ status: "expired" });
    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("expires live pending material at its persisted deadline", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const store = new MemoryPendingStore();
    store.pending = storedPending("s".repeat(43), NOW, new Date(NOW.getTime() + 60_000));
    const { flow } = createFlow({ now: () => now, store });
    await flow.initialize();

    now = new Date(NOW.getTime() + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(store.pending).toBeNull();
    flow.dispose();
  });

  it("coalesces concurrent starts into one browser authorization", async () => {
    let resolveAuthorization: ((value: { readonly authorizationUrl: string }) => void) | undefined;
    const authorization = new Promise<{ readonly authorizationUrl: string }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const beginDesktopAuthorization = vi.fn(() => authorization);
    const openExternal = vi.fn(async () => undefined);
    const { flow, store } = createFlow({
      api: authorizationApi(beginDesktopAuthorization),
      openExternal,
    });

    const first = flow.start();
    const second = flow.start();
    expect(second).toBe(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(beginDesktopAuthorization).toHaveBeenCalledOnce();
    expect(store.operations.filter((operation) => operation === "save")).toHaveLength(1);

    resolveAuthorization?.({ authorizationUrl: "https://example.authkit.app/authorize" });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(openExternal).toHaveBeenCalledOnce();
    flow.dispose();
  });

  it("serializes restart and callback races in invocation order", async () => {
    const store = new MemoryPendingStore();
    store.pending = storedPending();
    const { flow } = createFlow({ store });
    await flow.initialize();
    const oldState = store.pending?.state ?? "";

    const restart = flow.start();
    const staleCallback = flow.handleCallback({ code: HANDOFF_CODE, state: oldState });

    const replacement = await restart;
    await expect(staleCallback).resolves.toEqual({ status: "ignored" });
    expect(replacement.state).not.toBe(oldState);
    expect(store.pending?.state).toBe(replacement.state);
    flow.dispose();
  });

  it("does not release a handoff until pending material is durably retired", async () => {
    const store = new MemoryPendingStore();
    const { flow } = createFlow({ store });
    await flow.start();
    const callback = {
      code: HANDOFF_CODE,
      state: store.pending?.state ?? "",
    };
    store.clearError = new Error("credential store locked");

    await expect(flow.handleCallback(callback)).rejects.toThrow("credential store locked");
    expect(store.pending).not.toBeNull();

    store.clearError = null;
    await expect(flow.handleCallback(callback)).resolves.toMatchObject({ status: "handoff" });
    expect(store.pending).toBeNull();
    flow.dispose();
  });
});
