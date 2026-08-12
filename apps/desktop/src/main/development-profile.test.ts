import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  callbackForSignedOutSession,
  consumeDevelopmentAuthCallbackFile,
  resolveDevelopmentAuthCallbackFile,
  resolveDevelopmentProfile,
  resolveDevelopmentUserDataPath,
} from "./development-profile";

describe("resolveDevelopmentProfile", () => {
  it("accepts an optional lowercase slug", () => {
    expect(resolveDevelopmentProfile({})).toBe("");
    expect(resolveDevelopmentProfile({ HYPE_COMMS_DESKTOP_PROFILE: "dan-laptop" })).toBe(
      "dan-laptop",
    );
  });

  it("rejects values that could escape or alias the profile directory", () => {
    expect(() => resolveDevelopmentProfile({ HYPE_COMMS_DESKTOP_PROFILE: "../other" })).toThrow();
    expect(() => resolveDevelopmentProfile({ HYPE_COMMS_DESKTOP_PROFILE: "Morgan" })).toThrow();
  });
});

describe("development auth callback files", () => {
  it("allows callback files only for isolated unpackaged profiles", () => {
    const file = path.resolve("/tmp/claire.callback");
    expect(
      resolveDevelopmentAuthCallbackFile(
        { HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE: file },
        false,
        "claire",
      ),
    ).toBe(file);
    expect(resolveDevelopmentAuthCallbackFile({}, false, "claire")).toBeNull();
    expect(() =>
      resolveDevelopmentAuthCallbackFile(
        { HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE: file },
        true,
        "claire",
      ),
    ).toThrow();
    expect(() =>
      resolveDevelopmentAuthCallbackFile(
        { HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE: file },
        false,
        "",
      ),
    ).toThrow();
  });

  it("consumes a private file once and cannot replay it after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-callback-"));
    const file = path.join(directory, "claire.callback");
    await writeFile(file, "hype-comms://auth/callback?token=local\n", { mode: 0o600 });
    await chmod(file, 0o600);

    await expect(consumeDevelopmentAuthCallbackFile(file)).resolves.toBe(
      "hype-comms://auth/callback?token=local",
    );
    await expect(consumeDevelopmentAuthCallbackFile(file)).resolves.toBeNull();
  });

  it("removes an insecure callback without reading it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-callback-"));
    const file = path.join(directory, "claire.callback");
    await writeFile(file, "secret", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(consumeDevelopmentAuthCallbackFile(file)).rejects.toThrow(/0600/);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replace or clear a restored session", () => {
    const callback = "hype-comms://auth/callback?token=fresh";
    expect(callbackForSignedOutSession(callback, { status: "signed-out" })).toBe(callback);
    expect(
      callbackForSignedOutSession(callback, {
        status: "signed-in",
        method: "email",
        userId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "10000000-0000-4000-8000-000000000002",
        name: "Claire",
        email: "claire@example.test",
      }),
    ).toBeNull();
    expect(
      callbackForSignedOutSession(callback, {
        status: "session-unavailable",
        reason: "server_unreachable",
        message: "Server unavailable",
      }),
    ).toBeNull();
  });
});

describe("resolveDevelopmentUserDataPath", () => {
  it("roots isolated profiles under an explicit development directory", () => {
    const root = path.resolve("/tmp/hmm-demo/desktop");
    expect(
      resolveDevelopmentUserDataPath(
        { HYPE_COMMS_DEVELOPMENT_USER_DATA_ROOT: root },
        false,
        "woots",
        "/default",
      ),
    ).toBe(path.join(root, "woots"));
  });

  it("retains the ordinary profile layout without a development root", () => {
    expect(resolveDevelopmentUserDataPath({}, false, "claire", "/default")).toBe(
      path.join("/default", "development-claire"),
    );
  });
});
