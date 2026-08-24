import { createHash } from "node:crypto";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeCli } from "../src/cli.js";
import { loadProfileStore, saveProfile, updateProfileStore } from "../src/config.js";
import { EXIT_SUCCESS, EXIT_USAGE } from "../src/errors.js";
import { TIMESTAMP, USER_ID, WORKSPACE_ID, user } from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

const API_ORIGIN = "https://chat.example.test";
const CONFIG_DIRECTORY_NAME = "config";
const ENROLLMENT_ID = "77777777-7777-4777-8777-777777777777";
const CHILD_ID = "88888888-8888-4888-8888-888888888888";
const TOKEN_ID = "99999999-9999-4999-8999-999999999999";
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATLAS_TOKEN = `hype_comms_agent_${"t".repeat(43)}`;

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hype-comms-cli-enrollment-"));
}

function env(homeDirectory: string, profile: string): NodeJS.ProcessEnv {
  return {
    HYPE_COMMS_API_ORIGIN: API_ORIGIN,
    HYPE_COMMS_CONFIG_DIR: join(homeDirectory, CONFIG_DIRECTORY_NAME),
    HYPE_COMMS_PROFILE: profile,
  };
}

function enrollment(
  status: "pending_approval" | "ready_to_redeem" | "active" | "rejected" | "cancelled",
): Record<string, unknown> {
  const reviewed = status !== "pending_approval";
  const active = status === "active";
  return {
    id: ENROLLMENT_ID,
    workspaceId: WORKSPACE_ID,
    profile: "default-agency-v1",
    status,
    username: "child",
    displayName: "Child Agent",
    label: "child-runtime",
    requestedBy: USER_ID,
    requestedByKind: "agent",
    restrictedChannelIds: [],
    expiresAt: "2026-07-27T20:00:00.000Z",
    reviewedBy: reviewed ? OWNER_ID : null,
    reviewedAt: reviewed ? TIMESTAMP : null,
    activatedAgentUserId: active ? CHILD_ID : null,
    activatedAgentTokenId: active ? TOKEN_ID : null,
    activatedAt: active ? TIMESTAMP : null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function childAgent(): Record<string, unknown> {
  return {
    user: user({
      id: CHILD_ID,
      username: "child",
      displayName: "Child Agent",
    }),
    workspaceId: WORKSPACE_ID,
    role: "member",
    status: "active",
    createdBy: USER_ID,
    createdAt: TIMESTAMP,
    disabledAt: null,
  };
}

function childPrincipal(): Record<string, unknown> {
  return {
    type: "agent",
    user: user({
      id: CHILD_ID,
      username: "child",
      displayName: "Child Agent",
    }),
    workspaceId: WORKSPACE_ID,
    role: "member",
    scopes: ["workspace:read", "messages:write", "direct-conversations:write", "agents:invite"],
  };
}

describe("agent enrollment CLI", () => {
  it("completes a zero-copy offer/request/approve/redeem flow with no credential disclosure", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, CONFIG_DIRECTORY_NAME);

    const offerArgv = [
      "--profile",
      "child",
      "agent-enrollments",
      "offer",
      "child",
      "--display-name",
      "Child Agent",
      "--label",
      "child-runtime",
      "--json",
    ] as const;
    const offerRuntime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
    });
    expect(await executeCli(offerArgv, offerRuntime)).toBe(EXIT_SUCCESS);
    const offer = JSON.parse(offerRuntime.stdoutText()) as {
      profile: string;
      request: {
        username: string;
        displayName: string;
        label: string;
        credentialVerifier: string;
        restrictedChannelIds: string[];
      };
    };
    const offeredStore = await loadProfileStore(configDirectory);
    const candidate = offeredStore.profiles.child?.credential;
    expect(candidate?.kind).toBe("agent");
    if (candidate?.kind !== "agent") throw new Error("Missing candidate fixture");
    expect(candidate.token).toMatch(/^hype_comms_agent_[A-Za-z0-9_-]{43}$/u);
    expect(
      Buffer.from(candidate.token.slice("hype_comms_agent_".length), "base64url"),
    ).toHaveLength(32);
    expect(offer.request.credentialVerifier).toBe(
      createHash("sha256").update(candidate.token, "utf8").digest("base64url"),
    );
    expect(offer).toEqual({
      profile: "child",
      apiOrigin: API_ORIGIN,
      request: {
        username: "child",
        displayName: "Child Agent",
        label: "child-runtime",
        credentialVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        restrictedChannelIds: [],
      },
    });
    expect(offerRuntime.stdoutText()).not.toContain(candidate.token);
    expect(offerRuntime.stderrText()).not.toContain(candidate.token);
    expect(offerArgv).not.toContain(candidate.token);
    expect((await lstat(join(configDirectory, "profiles.json"))).mode & 0o777).toBe(0o600);

    await saveProfile({ env: env(homeDirectory, "atlas"), homeDirectory, now: Date.now }, "atlas", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "agent", token: ATLAS_TOKEN },
    });
    const observedUrls: string[] = [];
    const requestFetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      observedUrls.push(String(url));
      expect(String(url)).toBe(`${API_ORIGIN}/v1/agent-enrollments`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ATLAS_TOKEN}`);
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        `agent-enrollment:${offer.request.credentialVerifier}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual(offer.request);
      expect(String(init?.body)).not.toContain(candidate.token);
      return jsonResponse({ enrollment: enrollment("pending_approval") }, { status: 201 });
    });
    const requestArgv = [
      "--profile",
      "atlas",
      "agent-enrollments",
      "request",
      offer.request.username,
      "--display-name",
      offer.request.displayName,
      "--label",
      offer.request.label,
      "--credential-verifier",
      offer.request.credentialVerifier,
      "--json",
    ] as const;
    const requestRuntime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "atlas"),
      fetch: requestFetch,
    });
    expect(await executeCli(requestArgv, requestRuntime)).toBe(EXIT_SUCCESS);
    expect(JSON.parse(requestRuntime.stdoutText())).toMatchObject({
      enrollment: { id: ENROLLMENT_ID, status: "pending_approval" },
      idempotencyKey: `agent-enrollment:${offer.request.credentialVerifier}`,
    });
    expect(requestArgv).not.toContain(candidate.token);

    await saveProfile({ env: env(homeDirectory, "owner"), homeDirectory, now: Date.now }, "owner", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "human", sessionToken: "o".repeat(43) },
    });
    const approveArgv = [
      "--profile",
      "owner",
      "agent-enrollments",
      "approve",
      ENROLLMENT_ID,
      "--json",
    ] as const;
    const approveRuntime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "owner"),
      fetch: vi.fn<typeof globalThis.fetch>(async (url, init) => {
        observedUrls.push(String(url));
        expect(String(url)).toBe(`${API_ORIGIN}/v1/agent-enrollments/${ENROLLMENT_ID}/review`);
        expect(new Headers(init?.headers).get("cookie")).toBe(
          `hype_comms_session=${"o".repeat(43)}`,
        );
        expect(JSON.parse(String(init?.body))).toEqual({ decision: "approve" });
        return jsonResponse({ enrollment: enrollment("ready_to_redeem") });
      }),
    });
    expect(await executeCli(approveArgv, approveRuntime)).toBe(EXIT_SUCCESS);
    expect(approveArgv).not.toContain(candidate.token);

    const redeemArgv = [
      "--profile",
      "child",
      "agent-enrollments",
      "redeem",
      ENROLLMENT_ID,
      "--json",
    ] as const;
    const redeemFetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      observedUrls.push(String(url));
      if (String(url).endsWith(`/v1/agent-enrollments/${ENROLLMENT_ID}/redeem`)) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Enrollment ${candidate.token}`,
        );
        expect(init?.body).toBeUndefined();
        return jsonResponse({ enrollment: enrollment("active"), agent: childAgent() });
      }
      expect(String(url)).toBe(`${API_ORIGIN}/v1/auth/me`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${candidate.token}`);
      return jsonResponse(childPrincipal());
    });
    const redeemRuntime = testRuntime({
      homeDirectory,
      env: {
        ...env(homeDirectory, "child"),
        // Redemption deliberately ignores environment credentials and consumes only the selected
        // child's locally generated profile candidate.
        HYPE_COMMS_TOKEN: ATLAS_TOKEN,
      },
      fetch: redeemFetch,
    });
    expect(await executeCli(redeemArgv, redeemRuntime)).toBe(EXIT_SUCCESS);
    expect(JSON.parse(redeemRuntime.stdoutText())).toMatchObject({
      enrollment: { id: ENROLLMENT_ID, status: "active" },
      agent: { user: { id: CHILD_ID } },
      principal: { type: "agent", user: { id: CHILD_ID } },
      profile: "child",
      saved: true,
    });
    expect(redeemArgv).not.toContain(candidate.token);

    for (const output of [
      offerRuntime.stdoutText(),
      offerRuntime.stderrText(),
      requestRuntime.stdoutText(),
      requestRuntime.stderrText(),
      approveRuntime.stdoutText(),
      approveRuntime.stderrText(),
      redeemRuntime.stdoutText(),
      redeemRuntime.stderrText(),
    ]) {
      expect(output).not.toContain(candidate.token);
    }
    expect(observedUrls.every((url) => !url.includes(candidate.token))).toBe(true);
    expect(observedUrls.every((url) => !url.includes("agent-tokens"))).toBe(true);
    expect(requestFetch).toHaveBeenCalledOnce();
    expect(redeemFetch).toHaveBeenCalledTimes(2);
    expect((await loadProfileStore(configDirectory)).profiles.child?.credential).toEqual(candidate);
    expect((await lstat(join(configDirectory, "profiles.json"))).mode & 0o777).toBe(0o600);
  });

  it("recovers the same non-secret offer payload when initial stdout delivery is lost", async () => {
    const homeDirectory = await home();
    const first = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
    });
    expect(
      await executeCli(
        [
          "agent-enrollments",
          "offer",
          "child",
          "--display-name",
          "Child Agent",
          "--label",
          "child-runtime",
          "--json",
        ],
        first,
      ),
    ).toBe(EXIT_SUCCESS);
    const originalPayload = JSON.parse(first.stdoutText()) as { request: unknown };
    const storeAfterLostOutput = await loadProfileStore(join(homeDirectory, CONFIG_DIRECTORY_NAME));
    const candidate = storeAfterLostOutput.profiles.child?.credential;
    expect(candidate?.kind).toBe("agent");
    expect(storeAfterLostOutput.profiles.child?.enrollmentOffer?.request).toEqual(
      originalPayload.request,
    );

    // Simulate losing the first command's stdout entirely and rerunning from only private profile
    // state. Resume never authenticates or regenerates the candidate.
    const resumed = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
    });
    expect(await executeCli(["agent-enrollments", "offer", "--resume", "--json"], resumed)).toBe(
      EXIT_SUCCESS,
    );
    expect(JSON.parse(resumed.stdoutText())).toEqual(originalPayload);
    if (candidate?.kind !== "agent") throw new Error("Missing candidate fixture");
    expect(resumed.stdoutText()).not.toContain(candidate.token);
    expect(resumed.stderrText()).not.toContain(candidate.token);
    expect(
      (await loadProfileStore(join(homeDirectory, CONFIG_DIRECTORY_NAME))).profiles.child
        ?.credential,
    ).toEqual(candidate);
  });

  it("safely retries redemption after the server activates but the response is lost", async () => {
    const homeDirectory = await home();
    const offerRuntime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
    });
    expect(
      await executeCli(
        [
          "agent-enrollments",
          "offer",
          "child",
          "--display-name",
          "Child Agent",
          "--label",
          "child-runtime",
          "--json",
        ],
        offerRuntime,
      ),
    ).toBe(EXIT_SUCCESS);
    const configDirectory = join(homeDirectory, CONFIG_DIRECTORY_NAME);
    const candidate = (await loadProfileStore(configDirectory)).profiles.child?.credential;
    if (candidate?.kind !== "agent") throw new Error("Missing candidate fixture");

    let serverActivated = false;
    const first = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Enrollment ${candidate.token}`,
        );
        serverActivated = true;
        throw new TypeError("connection reset after activation");
      }),
    });
    expect(await executeCli(["agent-enrollments", "redeem", ENROLLMENT_ID, "--json"], first)).toBe(
      5,
    );
    expect(serverActivated).toBe(true);
    expect(first.stdoutText()).toBe("");
    expect(first.stderrText()).not.toContain(candidate.token);
    expect((await loadProfileStore(configDirectory)).profiles.child?.enrollmentOffer).toBeDefined();

    const second = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
      fetch: vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (String(url).endsWith(`/v1/agent-enrollments/${ENROLLMENT_ID}/redeem`)) {
          expect(serverActivated).toBe(true);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Enrollment ${candidate.token}`,
          );
          return jsonResponse({ enrollment: enrollment("active"), agent: childAgent() });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${candidate.token}`);
        return jsonResponse(childPrincipal());
      }),
    });
    expect(await executeCli(["agent-enrollments", "redeem", ENROLLMENT_ID, "--json"], second)).toBe(
      EXIT_SUCCESS,
    );
    expect(second.stdoutText()).not.toContain(candidate.token);
    expect(second.stderrText()).not.toContain(candidate.token);
    const completed = (await loadProfileStore(configDirectory)).profiles.child;
    expect(completed?.credential).toEqual(candidate);
    expect(completed?.enrollmentOffer).toBeUndefined();
  });

  it.each([
    { change: "logout", replacementOrigin: API_ORIGIN, replacementToken: undefined },
    {
      change: "credential replacement",
      replacementOrigin: API_ORIGIN,
      replacementToken: `hype_comms_agent_${"r".repeat(43)}`,
    },
    {
      change: "different-origin credential replacement",
      replacementOrigin: "https://other.example.test",
      replacementToken: `hype_comms_agent_${"x".repeat(43)}`,
    },
  ])(
    "preserves a concurrent $change while redemption is in flight",
    async ({ replacementOrigin, replacementToken }) => {
      const homeDirectory = await home();
      const configDirectory = join(homeDirectory, CONFIG_DIRECTORY_NAME);
      const offerRuntime = testRuntime({
        homeDirectory,
        env: env(homeDirectory, "child"),
      });
      expect(
        await executeCli(
          [
            "agent-enrollments",
            "offer",
            "child",
            "--display-name",
            "Child Agent",
            "--label",
            "child-runtime",
            "--json",
          ],
          offerRuntime,
        ),
      ).toBe(EXIT_SUCCESS);
      const candidate = (await loadProfileStore(configDirectory)).profiles.child?.credential;
      if (candidate?.kind !== "agent") throw new Error("Missing candidate fixture");

      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (String(url).endsWith(`/v1/agent-enrollments/${ENROLLMENT_ID}/redeem`)) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Enrollment ${candidate.token}`,
          );
          // Force the competing update into the network window before redemption's final profile
          // mutation. This uses the same lock and atomic store path as real profile commands.
          await updateProfileStore(
            { env: env(homeDirectory, "child"), homeDirectory, now: Date.now },
            (store) => {
              store.profiles.child = {
                apiOrigin: replacementOrigin,
                ...(replacementToken === undefined
                  ? {}
                  : { credential: { kind: "agent" as const, token: replacementToken } }),
              };
            },
          );
          return jsonResponse({ enrollment: enrollment("active"), agent: childAgent() });
        }
        expect(String(url)).toBe(`${API_ORIGIN}/v1/auth/me`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${candidate.token}`);
        return jsonResponse(childPrincipal());
      });
      const runtime = testRuntime({
        homeDirectory,
        env: env(homeDirectory, "child"),
        fetch,
      });

      expect(
        await executeCli(["agent-enrollments", "redeem", ENROLLMENT_ID, "--json"], runtime),
      ).toBe(EXIT_USAGE);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(runtime.stdoutText()).toBe("");
      expect(JSON.parse(runtime.stderrText())).toMatchObject({
        error: { code: "ENROLLMENT_PROFILE_CHANGED", retryable: false },
      });
      expect(runtime.stderrText()).not.toContain(candidate.token);
      if (replacementToken !== undefined) {
        expect(runtime.stderrText()).not.toContain(replacementToken);
      }

      const preserved = (await loadProfileStore(configDirectory)).profiles.child;
      expect(preserved?.apiOrigin).toBe(replacementOrigin);
      expect(preserved?.enrollmentOffer).toBeUndefined();
      expect(preserved?.credential).toEqual(
        replacementToken === undefined ? undefined : { kind: "agent", token: replacementToken },
      );
    },
  );

  it("rejects an enrollment candidate whose saved origin differs from the effective origin", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, CONFIG_DIRECTORY_NAME);
    const offerRuntime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
    });
    expect(
      await executeCli(
        [
          "agent-enrollments",
          "offer",
          "child",
          "--display-name",
          "Child Agent",
          "--label",
          "child-runtime",
          "--json",
        ],
        offerRuntime,
      ),
    ).toBe(EXIT_SUCCESS);
    const candidate = (await loadProfileStore(configDirectory)).profiles.child?.credential;
    if (candidate?.kind !== "agent") throw new Error("Missing candidate fixture");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({
      homeDirectory,
      env: {
        ...env(homeDirectory, "child"),
        HYPE_COMMS_API_ORIGIN: "https://other.example.test",
      },
      fetch,
    });

    expect(
      await executeCli(["agent-enrollments", "redeem", ENROLLMENT_ID, "--json"], runtime),
    ).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "CREDENTIAL_ORIGIN_MISMATCH", retryable: false },
    });
    expect(runtime.stderrText()).not.toContain(candidate.token);
  });

  it("does not accept an enrollment credential through argv", async () => {
    const homeDirectory = await home();
    const secret = `hype_comms_agent_${"s".repeat(43)}`;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
      fetch,
    });

    expect(
      await executeCli(
        ["agent-enrollments", "redeem", ENROLLMENT_ID, "--token", secret, "--json"],
        runtime,
      ),
    ).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stdoutText()).toBe("");
    expect(runtime.stderrText()).not.toContain(secret);
  });

  it("refuses to replace or disclose any credential already in the child profile", async () => {
    const homeDirectory = await home();
    const existing = `hype_comms_agent_${"e".repeat(43)}`;
    await saveProfile({ env: env(homeDirectory, "child"), homeDirectory, now: Date.now }, "child", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "agent", token: existing },
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtime = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "child"),
      fetch,
    });

    expect(
      await executeCli(
        [
          "agent-enrollments",
          "offer",
          "replacement",
          "--display-name",
          "Replacement",
          "--label",
          "replacement-runtime",
          "--json",
        ],
        runtime,
      ),
    ).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.stdoutText()).toBe("");
    expect(runtime.stderrText()).not.toContain(existing);
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "PROFILE_HAS_CREDENTIAL", retryable: false },
    });
    const stored = (await loadProfileStore(join(homeDirectory, CONFIG_DIRECTORY_NAME))).profiles
      .child;
    expect(stored?.credential).toEqual({ kind: "agent", token: existing });
    expect(stored?.enrollmentOffer).toBeUndefined();
  });

  it("supports requester status/cancel and owner list operations", async () => {
    const homeDirectory = await home();
    await saveProfile({ env: env(homeDirectory, "atlas"), homeDirectory, now: Date.now }, "atlas", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "agent", token: ATLAS_TOKEN },
    });
    const cases = [
      {
        args: ["status", ENROLLMENT_ID],
        method: "GET",
        path: `/v1/agent-enrollments/${ENROLLMENT_ID}`,
        body: { enrollment: enrollment("pending_approval") },
      },
      {
        args: ["cancel", ENROLLMENT_ID],
        method: "POST",
        path: `/v1/agent-enrollments/${ENROLLMENT_ID}/cancel`,
        body: { enrollment: enrollment("cancelled") },
      },
      {
        args: ["list"],
        method: "GET",
        path: "/v1/agent-enrollments",
        body: { enrollments: [enrollment("pending_approval")] },
      },
    ] as const;
    for (const testCase of cases) {
      const runtime = testRuntime({
        homeDirectory,
        env: env(homeDirectory, "atlas"),
        fetch: vi.fn<typeof globalThis.fetch>(async (url, init) => {
          expect(new URL(String(url)).pathname).toBe(testCase.path);
          expect(init?.method ?? "GET").toBe(testCase.method);
          return jsonResponse(testCase.body);
        }),
      });
      expect(await executeCli(["agent-enrollments", ...testCase.args, "--json"], runtime)).toBe(
        EXIT_SUCCESS,
      );
    }
  });

  it("lets an owner list and reject a pending enrollment without handling its candidate", async () => {
    const homeDirectory = await home();
    await saveProfile({ env: env(homeDirectory, "owner"), homeDirectory, now: Date.now }, "owner", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "human", sessionToken: "o".repeat(43) },
    });
    const list = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "owner"),
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get("cookie")).toBe(
          `hype_comms_session=${"o".repeat(43)}`,
        );
        return jsonResponse({ enrollments: [enrollment("pending_approval")] });
      }),
    });
    expect(await executeCli(["agent-enrollments", "list", "--json"], list)).toBe(EXIT_SUCCESS);

    const reject = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "owner"),
      fetch: vi.fn<typeof globalThis.fetch>(async (url, init) => {
        expect(String(url)).toBe(`${API_ORIGIN}/v1/agent-enrollments/${ENROLLMENT_ID}/review`);
        expect(JSON.parse(String(init?.body))).toEqual({ decision: "reject" });
        return jsonResponse({ enrollment: enrollment("rejected") });
      }),
    });
    expect(await executeCli(["agent-enrollments", "reject", ENROLLMENT_ID, "--json"], reject)).toBe(
      EXIT_SUCCESS,
    );
  });

  it("shows and sets the explicit workspace enrollment policy", async () => {
    const homeDirectory = await home();
    await saveProfile({ env: env(homeDirectory, "owner"), homeDirectory, now: Date.now }, "owner", {
      apiOrigin: API_ORIGIN,
      credential: { kind: "human", sessionToken: "o".repeat(43) },
    });
    const show = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "owner"),
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({
          policy: { workspaceId: WORKSPACE_ID, mode: "required", updatedAt: TIMESTAMP },
        });
      }),
    });
    expect(await executeCli(["agent-enrollment-policy", "show", "--json"], show)).toBe(
      EXIT_SUCCESS,
    );

    const set = testRuntime({
      homeDirectory,
      env: env(homeDirectory, "owner"),
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ mode: "automatic" });
        return jsonResponse({
          policy: { workspaceId: WORKSPACE_ID, mode: "automatic", updatedAt: TIMESTAMP },
        });
      }),
    });
    expect(await executeCli(["agent-enrollment-policy", "set", "automatic", "--json"], set)).toBe(
      EXIT_SUCCESS,
    );
  });
});
