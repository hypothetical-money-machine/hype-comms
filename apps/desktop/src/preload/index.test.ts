import { beforeEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_CHANNELS } from "../shared/channels";
import type { DesktopApi } from "../shared/desktop-api";

/**
 * The bridge is the renderer's only door to the network, so every response it hands back has to be
 * re-validated on this side: a compromised or simply out-of-date main process must not be able to
 * put a shape the wire contract forbids into the renderer's cache.
 */
const invoke = vi.fn();
const exposed: Record<string, unknown> = {};

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>): void => {
      Object.assign(exposed, api);
    },
  },
  ipcRenderer: {
    invoke: (...args: readonly unknown[]) => invoke(...args) as unknown,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

await import("./index");

const desktopApi = exposed as unknown as DesktopApi;

const NOW = "2026-07-24T12:00:00.000Z";
const MEMBER = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

beforeEach(() => {
  invoke.mockReset();
});

describe("preload listWorkspaceMembers", () => {
  it("invokes the members channel with no request payload", async () => {
    invoke.mockResolvedValueOnce({ members: [MEMBER] });

    await expect(desktopApi.listWorkspaceMembers()).resolves.toEqual({ members: [MEMBER] });
    expect(invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.workspaceMembersList);
  });

  it("rejects a member directory that the wire contract does not allow", async () => {
    // The removal signal deliberately has no status field anywhere in the member shape. A payload
    // that grew one is a contract drift the renderer must never cache.
    invoke.mockResolvedValueOnce({ members: [{ ...MEMBER, status: "revoked" }] });

    await expect(desktopApi.listWorkspaceMembers()).rejects.toThrow();
  });

  it("rejects a directory response that is not an object at all", async () => {
    invoke.mockResolvedValueOnce(null);

    await expect(desktopApi.listWorkspaceMembers()).rejects.toThrow();
  });
});
