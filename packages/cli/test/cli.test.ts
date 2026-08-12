import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { executeCli } from "../src/cli.js";
import { loadProfileStore, saveProfile } from "../src/config.js";
import { EXIT_SUCCESS, EXIT_USAGE } from "../src/errors.js";
import { agentPrincipal, CLIENT_MESSAGE_ID, CONVERSATION_ID } from "./fixtures.js";
import { jsonResponse, testRuntime } from "./helpers.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hype-comms-cli-run-"));
}

describe("CLI output and exit contracts", () => {
  it("keeps JSON errors on stderr and stdout empty", async () => {
    const runtime = testRuntime({ homeDirectory: await home() });
    const exitCode = await executeCli(["--json", "not-a-command"], runtime);
    expect(exitCode).toBe(EXIT_USAGE);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: { code: "USAGE", retryable: false },
    });
  });

  it("keeps successful JSON on stdout with no diagnostics", async () => {
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: { HYPE_COMMS_API_ORIGIN: "https://chat.example.test" },
      fetch: vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ status: "ok" })),
    });
    const exitCode = await executeCli(["health", "--json"], runtime);
    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(JSON.parse(runtime.stdoutText())).toEqual({ status: "ok" });
    expect(runtime.stderrText()).toBe("");
  });

  it("serializes rotated profile refreshes across concurrent CLI processes", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, "config");
    const env = {
      HYPE_COMMS_CONFIG_DIR: configDirectory,
      HYPE_COMMS_PROFILE: "work",
    };
    await saveProfile({ env, homeDirectory, now: Date.now }, "work", {
      apiOrigin: "https://chat.example.test",
      credential: { kind: "human", sessionToken: "a".repeat(43) },
    });
    const observed: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get("cookie")?.replace("hmm_session=", "");
      observed.push(token ?? "");
      const next = observed.length === 1 ? "b".repeat(43) : "c".repeat(43);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": `hmm_session=${next}; Path=/; HttpOnly` },
      });
    });
    const first = testRuntime({ homeDirectory, env, fetch });
    const second = testRuntime({ homeDirectory, env, fetch });
    const results = await Promise.all([
      executeCli(["auth", "refresh", "--json"], first),
      executeCli(["auth", "refresh", "--json"], second),
    ]);

    expect(results).toEqual([EXIT_SUCCESS, EXIT_SUCCESS]);
    expect(observed).toEqual(["a".repeat(43), "b".repeat(43)]);
    expect((await loadProfileStore(configDirectory)).profiles.work?.credential).toEqual({
      kind: "human",
      sessionToken: "c".repeat(43),
    });
  });

  it("uses one UUID for the message body, header, and uncertain-delivery error", async () => {
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: {
        HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
        expect(body.clientMessageId).toBe(CLIENT_MESSAGE_ID);
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(CLIENT_MESSAGE_ID);
        throw new TypeError("connection reset after write");
      }),
    });
    const exitCode = await executeCli(
      [
        "messages",
        "send",
        CONVERSATION_ID,
        "hello",
        "--client-message-id",
        CLIENT_MESSAGE_ID,
        "--json",
      ],
      runtime,
    );
    expect(exitCode).toBe(5);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toMatchObject({
      error: {
        code: "NETWORK_ERROR",
        retryable: true,
        clientMessageId: CLIENT_MESSAGE_ID,
      },
    });
  });

  it.each([
    {
      label: "authentication",
      response: jsonResponse(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Sign in",
            requestId: "request-auth",
          },
        },
        { status: 401 },
      ),
      exitCode: 3,
    },
    {
      label: "permanent API rejection",
      response: jsonResponse(
        {
          error: {
            code: "NOT_FOUND",
            message: "Missing",
            requestId: "request-api",
          },
        },
        { status: 404 },
      ),
      exitCode: 4,
    },
    {
      label: "transient server failure",
      response: jsonResponse(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Unavailable",
            requestId: "request-server",
          },
        },
        { status: 503 },
      ),
      exitCode: 5,
    },
    {
      label: "invalid contract",
      response: jsonResponse({ invalid: true }),
      exitCode: 6,
    },
  ])("maps $label to exit $exitCode", async ({ response, exitCode }) => {
    const runtime = testRuntime({
      homeDirectory: await home(),
      env: {
        HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
        HYPE_COMMS_TOKEN: `hype_comms_agent_${"a".repeat(43)}`,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async () => response.clone()),
    });
    expect(await executeCli(["auth", "whoami", "--json"], runtime)).toBe(exitCode);
    expect(runtime.stdoutText()).toBe("");
    expect(JSON.parse(runtime.stderrText())).toHaveProperty("error.code");
  });

  it("privately saves a piped agent token after validating it", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, "config");
    const token = `hype_comms_agent_${"p".repeat(43)}`;
    const runtime = testRuntime({
      homeDirectory,
      env: {
        HYPE_COMMS_CONFIG_DIR: configDirectory,
        HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
      },
      stdin: `${token}\n`,
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        return jsonResponse(agentPrincipal());
      }),
    });
    expect(await executeCli(["auth", "login-agent", "--save", "--json"], runtime)).toBe(0);
    expect((await loadProfileStore(configDirectory)).profiles.default?.credential).toEqual({
      kind: "agent",
      token,
    });
  });

  it("uses an environment agent token without persisting it", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, "config");
    const token = `hype_comms_agent_${"e".repeat(43)}`;
    const runtime = testRuntime({
      homeDirectory,
      env: {
        HYPE_COMMS_CONFIG_DIR: configDirectory,
        HYPE_COMMS_API_ORIGIN: "https://chat.example.test",
        HYPE_COMMS_TOKEN: token,
      },
      fetch: vi.fn<typeof globalThis.fetch>(async () => jsonResponse(agentPrincipal())),
    });
    expect(await executeCli(["auth", "whoami", "--json"], runtime)).toBe(0);
    expect((await loadProfileStore(configDirectory)).profiles).toEqual({});
  });

  it.each([
    {
      kind: "human" as const,
      credential: { kind: "human" as const, sessionToken: "h".repeat(43) },
      override: "argument" as const,
    },
    {
      kind: "agent" as const,
      credential: {
        kind: "agent" as const,
        token: `hype_comms_agent_${"a".repeat(43)}`,
      },
      override: "environment" as const,
    },
  ])(
    "does not send a saved $kind credential to an origin override from the $override",
    async ({ credential, override }) => {
      const homeDirectory = await home();
      const configDirectory = join(homeDirectory, "config");
      const baseEnv = {
        HYPE_COMMS_CONFIG_DIR: configDirectory,
        HYPE_COMMS_PROFILE: "work",
      };
      await saveProfile({ env: baseEnv, homeDirectory, now: Date.now }, "work", {
        apiOrigin: "https://stored.example.test",
        credential,
      });
      const fetch = vi.fn<typeof globalThis.fetch>();
      const runtime = testRuntime({
        homeDirectory,
        env:
          override === "environment"
            ? { ...baseEnv, HYPE_COMMS_API_ORIGIN: "https://override.example.test" }
            : baseEnv,
        fetch,
      });
      const args =
        override === "argument"
          ? ["auth", "whoami", "--api-origin", "https://override.example.test", "--json"]
          : ["auth", "whoami", "--json"];

      expect(await executeCli(args, runtime)).toBe(EXIT_USAGE);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(runtime.stderrText())).toMatchObject({
        error: { code: "CREDENTIAL_ORIGIN_MISMATCH", retryable: false },
      });
    },
  );

  it("allows an environment token to replace a saved credential at an overridden origin", async () => {
    const homeDirectory = await home();
    const configDirectory = join(homeDirectory, "config");
    const token = `hype_comms_agent_${"r".repeat(43)}`;
    await saveProfile(
      {
        env: { HYPE_COMMS_CONFIG_DIR: configDirectory },
        homeDirectory,
        now: Date.now,
      },
      "work",
      {
        apiOrigin: "https://stored.example.test",
        credential: { kind: "human", sessionToken: "h".repeat(43) },
      },
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://override.example.test/v1/auth/me");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return jsonResponse(agentPrincipal());
    });
    const runtime = testRuntime({
      homeDirectory,
      env: {
        HYPE_COMMS_CONFIG_DIR: configDirectory,
        HYPE_COMMS_PROFILE: "work",
        HYPE_COMMS_API_ORIGIN: "https://override.example.test",
        HYPE_COMMS_TOKEN: token,
      },
      fetch,
    });

    expect(await executeCli(["auth", "whoami", "--json"], runtime)).toBe(EXIT_SUCCESS);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["refresh", "logout"] as const)(
    "leaves a saved session untouched when auth %s is given another origin",
    async (command) => {
      const homeDirectory = await home();
      const configDirectory = join(homeDirectory, "config");
      const env = {
        HYPE_COMMS_CONFIG_DIR: configDirectory,
        HYPE_COMMS_PROFILE: "work",
        HYPE_COMMS_API_ORIGIN: "https://override.example.test",
      };
      const credential = { kind: "human" as const, sessionToken: "s".repeat(43) };
      await saveProfile({ env, homeDirectory, now: Date.now }, "work", {
        apiOrigin: "https://stored.example.test",
        credential,
      });
      const fetch = vi.fn<typeof globalThis.fetch>();
      const runtime = testRuntime({ homeDirectory, env, fetch });

      expect(await executeCli(["auth", command, "--json"], runtime)).toBe(EXIT_USAGE);
      expect(fetch).not.toHaveBeenCalled();
      expect((await loadProfileStore(configDirectory)).profiles.work?.credential).toEqual(
        credential,
      );
      expect(JSON.parse(runtime.stderrText())).toMatchObject({
        error: { code: "CREDENTIAL_ORIGIN_MISMATCH", retryable: false },
      });
    },
  );
});
