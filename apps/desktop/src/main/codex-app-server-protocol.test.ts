import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  CodexProtocolError,
  MAX_CODEX_JSON_DEPTH,
  codexApprovalTool,
  codexPermissionRequest,
  codexThreadPolicy,
  codexTurnPolicy,
  encodeCodexClientRequest,
  isMissingCodexThreadError,
  isSupportedCodexCliVersion,
  normalizeCodexNetworkHost,
  parseAccountResult,
  parseCodexCliVersion,
  parseCodexJsonRpcLine,
  parseCodexNotification,
  parseCodexServerRequest,
  sanitizeCodexCommandPreview,
} from "./codex-app-server-protocol";

function turn(status: "completed" | "interrupted" | "failed" | "inProgress") {
  return {
    id: "turn-a",
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 10,
    completedAt: status === "inProgress" ? null : 11,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function commandApproval(command: string | null) {
  return {
    threadId: "thread-a",
    turnId: "turn-a",
    itemId: "item-a",
    startedAtMs: 10,
    approvalId: null,
    environmentId: null,
    reason: null,
    networkApprovalContext: null,
    command,
    cwd: null,
    commandActions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  };
}

describe("Codex 0.147.0 JSON-RPC projection", () => {
  it("classifies responses, requests, and notifications without requiring jsonrpc", () => {
    expect(parseCodexJsonRpcLine('{"id":4,"result":{"ok":true}}')).toEqual({
      kind: "response",
      id: 4,
      result: { ok: true },
    });
    expect(
      parseCodexJsonRpcLine(
        '{"id":"approval-rpc","method":"item/fileChange/requestApproval","params":{}}',
      ),
    ).toEqual({
      kind: "request",
      id: "approval-rpc",
      method: "item/fileChange/requestApproval",
      params: {},
    });
    expect(parseCodexJsonRpcLine('{"method":"initialized","params":{}}')).toEqual({
      kind: "notification",
      method: "initialized",
      params: {},
    });
  });

  it("rejects ambiguous envelopes, null response IDs, and excessive nesting", () => {
    expect(() =>
      parseCodexJsonRpcLine('{"id":1,"result":{},"error":{"code":1,"message":"bad"}}'),
    ).toThrow(CodexProtocolError);
    expect(() => parseCodexJsonRpcLine('{"id":null,"result":{}}')).toThrow(CodexProtocolError);
    expect(() => parseCodexJsonRpcLine('{"id":null,"method":"warning","params":{}}')).toThrow(
      CodexProtocolError,
    );
    expect(() => parseCodexJsonRpcLine('{"id":1,"result":{},"unexpected":true}')).toThrow(
      CodexProtocolError,
    );
    expect(() => parseCodexJsonRpcLine('{"method":"warning"}')).toThrow(CodexProtocolError);
    const nested = `${"[".repeat(MAX_CODEX_JSON_DEPTH + 1)}0${"]".repeat(
      MAX_CODEX_JSON_DEPTH + 1,
    )}`;
    expect(() => parseCodexJsonRpcLine(nested)).toThrow(CodexProtocolError);
  });

  it("caps outgoing envelopes before a write", () => {
    expect(
      encodeCodexClientRequest(1, "account/read", { refreshToken: false }).toString("utf8"),
    ).toBe('{"method":"account/read","id":1,"params":{"refreshToken":false}}\n');
    expect(() =>
      encodeCodexClientRequest(1, "turn/start", { text: "x".repeat(1_100_000) }),
    ).toThrow(CodexProtocolError);
  });

  it("accepts only the pinned CLI version and narrowly classifies missing threads", () => {
    expect(parseCodexCliVersion("codex-cli 0.147.0\n")).toBe("0.147.0");
    expect(parseCodexCliVersion("warning\ncodex-cli 0.147.0\n")).toBeNull();
    expect(isSupportedCodexCliVersion("0.147.0")).toBe(true);
    expect(isSupportedCodexCliVersion("0.146.0")).toBe(false);
    expect(isSupportedCodexCliVersion("0.148.0")).toBe(false);
    expect(isMissingCodexThreadError({ code: -32000, message: "Thread abc not found" })).toBe(true);
    expect(
      isMissingCodexThreadError({ code: -32000, message: "No rollout found for thread abc" }),
    ).toBe(true);
    expect(
      isMissingCodexThreadError({ code: -32000, message: "Authentication token not found" }),
    ).toBe(false);
    expect(isMissingCodexThreadError({ code: -32000, message: "Request timed out" })).toBe(false);
  });

  it("reduces account state without retaining account details", () => {
    expect(
      parseAccountResult({
        account: { type: "chatgpt", email: "private@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ authenticated: true });
    expect(parseAccountResult({ account: null, requiresOpenaiAuth: true })).toEqual({
      authenticated: false,
    });
    expect(parseAccountResult({ account: null, requiresOpenaiAuth: false })).toEqual({
      authenticated: true,
    });
    expect(() => parseAccountResult({})).toThrow(CodexProtocolError);
    expect(() => parseAccountResult({ account: {}, requiresOpenaiAuth: true })).toThrow(
      CodexProtocolError,
    );
    expect(() =>
      parseAccountResult({
        account: { type: "chatgpt", email: null, planType: "invented" },
        requiresOpenaiAuth: true,
      }),
    ).toThrow(CodexProtocolError);
  });
});

describe("Codex notification projection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hype-codex-protocol-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("validates lifecycle correlation and only treats turn completion as terminal", () => {
    expect(
      parseCodexNotification(
        "turn/started",
        { threadId: "thread-a", turn: turn("inProgress") },
        workspace,
      ),
    ).toEqual({
      kind: "turn-started",
      threadId: "thread-a",
      turnId: "turn-a",
      status: "inProgress",
    });
    expect(
      parseCodexNotification(
        "turn/completed",
        { threadId: "thread-a", turn: turn("completed") },
        workspace,
      ),
    ).toEqual({
      kind: "turn-completed",
      threadId: "thread-a",
      turnId: "turn-a",
      status: "completed",
    });
    expect(() =>
      parseCodexNotification(
        "turn/completed",
        { threadId: "thread-a", turn: { ...turn("completed"), id: undefined } },
        workspace,
      ),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexNotification(
        "turn/completed",
        {
          threadId: "thread-a",
          turn: { ...turn("completed"), unexpected: "payload" },
        },
        workspace,
      ),
    ).toThrow(CodexProtocolError);
  });

  it("keeps summary reasoning and discards raw reasoning", () => {
    expect(
      parseCodexNotification(
        "item/reasoning/summaryTextDelta",
        {
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: "reasoning-a",
          delta: "Checking the workspace",
          summaryIndex: 0,
        },
        workspace,
      ),
    ).toMatchObject({ kind: "reasoning-summary-delta", delta: "Checking the workspace" });
    expect(
      parseCodexNotification(
        "item/reasoning/textDelta",
        {
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: "reasoning-a",
          delta: "private chain of thought",
          contentIndex: 0,
        },
        workspace,
      ),
    ).toEqual({ kind: "unknown", method: "item/reasoning/textDelta" });
  });

  it("projects final assistant text but never command output or patches", () => {
    const assistant = parseCodexNotification(
      "item/completed",
      {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "agentMessage",
          id: "assistant-provider-id",
          text: "Done",
          phase: null,
          memoryCitation: null,
        },
        completedAtMs: 10,
      },
      workspace,
    );
    expect(assistant).toMatchObject({
      kind: "item-completed",
      item: { type: "agent-message", text: "Done" },
    });

    const command = parseCodexNotification(
      "item/completed",
      {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "commandExecution",
          id: "command-provider-id",
          pluginId: null,
          scriptPath: null,
          command: "cat /home/alice/.ssh/id_rsa --token super-secret",
          cwd: workspace,
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "PRIVATE OUTPUT",
          exitCode: 0,
          durationMs: 10,
        },
        completedAtMs: 10,
      },
      workspace,
    );
    expect(JSON.stringify(command)).not.toContain("PRIVATE OUTPUT");
    expect(JSON.stringify(command)).not.toContain("super-secret");
    expect(JSON.stringify(command)).not.toContain("/home/alice");

    const file = parseCodexNotification(
      "item/completed",
      {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "fileChange",
          id: "file-provider-id",
          status: "completed",
          changes: [
            {
              path: `${workspace}/src/app.ts`,
              kind: { type: "update", move_path: null },
              diff: "PRIVATE PATCH",
            },
          ],
        },
        completedAtMs: 10,
      },
      workspace,
    );
    expect(file).toMatchObject({ item: { locations: ["src/app.ts"] } });
    expect(JSON.stringify(file)).not.toContain("PRIVATE PATCH");
  });

  it("uses a generic item title when a command cannot be previewed safely", () => {
    for (const rawCommand of ["bash -lc echo don't", "/usr/bin/env", "--token secret"]) {
      expect(
        parseCodexNotification(
          "item/started",
          {
            threadId: "thread-a",
            turnId: "turn-a",
            item: {
              type: "commandExecution",
              id: "command-provider-id",
              pluginId: null,
              scriptPath: null,
              command: rawCommand,
              cwd: workspace,
              processId: null,
              source: "agent",
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            startedAtMs: 10,
          },
          workspace,
        ),
      ).toMatchObject({
        kind: "item-started",
        item: { type: "tool", title: "Run a command" },
      });
      expect(() =>
        parseCodexServerRequest(
          7,
          "item/commandExecution/requestApproval",
          commandApproval(rawCommand),
        ),
      ).toThrow(CodexProtocolError);
    }
  });

  it("rejects every unsafe file-change path instead of filtering it from the preview", () => {
    symlinkSync(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const fileItem = (filePath: string) => ({
      threadId: "thread-a",
      turnId: "turn-a",
      item: {
        type: "fileChange",
        id: "file-provider-id",
        status: "inProgress",
        changes: [
          {
            path: filePath,
            kind: { type: "update", move_path: null },
            diff: "patch",
          },
        ],
      },
      startedAtMs: 10,
    });

    expect(() =>
      parseCodexNotification("item/started", fileItem("src/../app.ts"), workspace),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexNotification("item/started", fileItem(path.join(outside, "secret.txt")), workspace),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexNotification("item/started", fileItem("escape/secret.txt"), workspace),
    ).toThrow(CodexProtocolError);
  });

  it("caches canonical workspace roots with bounded eviction", () => {
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "hype-codex-root-cache-"));
    const workspaces = Array.from({ length: 33 }, (_, index) => {
      const candidate = path.join(cacheRoot, `workspace-${String(index)}`);
      mkdirSync(candidate);
      mkdirSync(path.join(candidate, "src"));
      return candidate;
    });
    const realpathSpy = vi.spyOn(realpathSync, "native");
    const parseImage = (workspacePath: string) =>
      parseCodexNotification(
        "item/started",
        {
          threadId: "thread-a",
          turnId: "turn-a",
          item: { type: "imageView", id: "image-a", path: "src" },
          startedAtMs: 10,
        },
        workspacePath,
      );

    try {
      const firstWorkspace = workspaces[0];
      if (firstWorkspace === undefined) throw new Error("expected a workspace");
      expect(parseImage(firstWorkspace)).toMatchObject({ item: { locations: ["src"] } });
      expect(parseImage(firstWorkspace)).toMatchObject({ item: { locations: ["src"] } });
      expect(
        realpathSpy.mock.calls.filter(([candidate]) => candidate === firstWorkspace),
      ).toHaveLength(1);

      for (const workspacePath of workspaces.slice(1)) parseImage(workspacePath);
      parseImage(firstWorkspace);
      expect(
        realpathSpy.mock.calls.filter(([candidate]) => candidate === firstWorkspace),
      ).toHaveLength(2);
    } finally {
      realpathSpy.mockRestore();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a cached workspace alias is retargeted", () => {
    const aliasRoot = mkdtempSync(path.join(tmpdir(), "hype-codex-root-alias-"));
    const firstTarget = path.join(aliasRoot, "first");
    const secondTarget = path.join(aliasRoot, "second");
    const workspaceAlias = path.join(aliasRoot, "workspace");
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    mkdirSync(path.join(firstTarget, "src"));
    mkdirSync(path.join(secondTarget, "src"));
    symlinkSync(firstTarget, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    const fileItem = {
      threadId: "thread-a",
      turnId: "turn-a",
      item: {
        type: "fileChange",
        id: "file-provider-id",
        status: "inProgress",
        changes: [{ path: "src", kind: { type: "update", move_path: null }, diff: "patch" }],
      },
      startedAtMs: 10,
    };

    try {
      expect(parseCodexNotification("item/started", fileItem, workspaceAlias)).toMatchObject({
        item: { locations: ["src"] },
      });
      unlinkSync(workspaceAlias);
      symlinkSync(secondTarget, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
      expect(() => parseCodexNotification("item/started", fileItem, workspaceAlias)).toThrow(
        CodexProtocolError,
      );
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });

  it("bounds and maps plans without inventing priorities", () => {
    expect(
      parseCodexNotification(
        "turn/plan/updated",
        {
          threadId: "thread-a",
          turnId: "turn-a",
          explanation: "not projected",
          plan: [
            { step: "Inspect", status: "inProgress" },
            { step: "Test", status: "pending" },
          ],
        },
        workspace,
      ),
    ).toEqual({
      kind: "plan-updated",
      threadId: "thread-a",
      turnId: "turn-a",
      plan: [
        { step: "Inspect", status: "in_progress" },
        { step: "Test", status: "pending" },
      ],
    });
  });
});

describe("Codex approvals and fixed policy", () => {
  it("preserves RPC, approval, and item identifiers separately inside the projection", () => {
    expect(
      parseCodexServerRequest("rpc-1", "item/commandExecution/requestApproval", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-a",
        approvalId: "approval-a",
        startedAtMs: 10,
        environmentId: null,
        command: "curl https://example.com",
        networkApprovalContext: { host: "EXAMPLE.COM", protocol: "https" },
      }),
    ).toEqual({
      kind: "command-approval",
      rpcId: "rpc-1",
      approvalKey: "approval-a",
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      command: "curl https://example.com",
      networkHost: "example.com",
      networkProtocol: "https",
    });
  });

  it("recognizes blanket permissions separately so the worker can deny them", () => {
    expect(
      parseCodexServerRequest(7, "item/permissions/requestApproval", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-a",
        environmentId: null,
        startedAtMs: 10,
        cwd: "/workspace/project",
        reason: "network",
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/home/alice"], write: null },
        },
      }),
    ).toMatchObject({
      kind: "permissions-approval",
      rpcId: 7,
      requestsNetwork: true,
      requestsFileSystem: true,
    });
  });

  it("offers only candidate decisions supported by the Lite cut", () => {
    const parsed = parseCodexServerRequest(
      7,
      "item/commandExecution/requestApproval",
      commandApproval("npm test"),
    );
    if (parsed.kind !== "command-approval") throw new Error("expected command approval");
    const tool = codexApprovalTool(parsed, "local-item", "/workspace/project", []);
    expect(codexPermissionRequest("thread-a", tool).options).toEqual([
      { id: "accept", name: "Allow once", kind: "allow_once" },
      { id: "decline", name: "Reject", kind: "reject_once" },
    ]);
  });

  it("sanitizes command labels and validates network hosts", () => {
    const preview = sanitizeCodexCommandPreview(
      "\u202E cat /home/alice/private --api-key=secret PASSWORD=hunter2",
    );
    if (preview === null) throw new Error("expected a safe preview");
    expect(preview).not.toContain("\u202E");
    expect(preview).not.toContain("/home/alice");
    expect(preview).not.toContain("secret");
    expect(preview).not.toContain("hunter2");
    expect(normalizeCodexNetworkHost("Example.COM")).toBe("example.com");
    expect(normalizeCodexNetworkHost("example.com:443/path")).toBeNull();
    expect(normalizeCodexNetworkHost("example..com")).toBeNull();
    expect(normalizeCodexNetworkHost("::::")).toBeNull();
  });

  it("redacts quoted flags, authorization headers, environment secrets, and URL credentials", () => {
    const preview = sanitizeCodexCommandPreview(
      `curl --api-key="secret value" -H 'Authorization: Bearer header-secret' ` +
        `OPENAI_API_KEY='env secret' https://alice:url-secret@example.com/private?token=query-secret`,
    );
    if (preview === null) throw new Error("expected a safe preview");
    expect(preview).toContain("curl");
    expect(preview).toContain("--api-key=<redacted>");
    expect(preview).toContain("-H <redacted>");
    expect(preview).toContain("<redacted>@example.com");
    for (const secret of [
      "secret value",
      "header-secret",
      "env secret",
      "alice",
      "url-secret",
      "private",
      "query-secret",
    ]) {
      expect(preview).not.toContain(secret);
    }

    const splitPreview = sanitizeCodexCommandPreview(
      "curl -H Authorization: Bearer split-header --authorization=Bearer split-flag API_KEY = split-env --api-key:colon-secret",
    );
    if (splitPreview === null) throw new Error("expected a safe split-token preview");
    expect(splitPreview).toContain("curl");
    for (const secret of ["split-header", "split-flag", "split-env", "colon-secret"]) {
      expect(splitPreview).not.toContain(secret);
    }
  });

  it("denies missing, unterminated, or otherwise unshowable command approvals", () => {
    expect(() =>
      parseCodexServerRequest(7, "item/commandExecution/requestApproval", commandApproval(null)),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexServerRequest(
        7,
        "item/commandExecution/requestApproval",
        commandApproval("--token 'unterminated"),
      ),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexServerRequest(
        7,
        "item/commandExecution/requestApproval",
        commandApproval("--token secret"),
      ),
    ).toThrow(CodexProtocolError);
  });

  it("renders managed-network approvals as destination-only even with a secret command", () => {
    const parsed = parseCodexServerRequest(7, "item/commandExecution/requestApproval", {
      ...commandApproval(`curl --authorization "Bearer secret-value" ${"argument ".repeat(200)}`),
      networkApprovalContext: { host: "EXAMPLE.COM", protocol: "https" },
    });
    if (parsed.kind !== "command-approval") throw new Error("expected command approval");
    const tool = codexApprovalTool(parsed, "local-item", "/workspace/project", []);
    if (typeof tool.title !== "string") throw new Error("expected a title");
    expect(tool.title).toBe("Connect to https://example.com");
    expect(tool.title).not.toContain("curl");
    expect(tool.title).not.toContain("secret-value");
    expect(Buffer.byteLength(tool.title, "utf8")).toBeLessThanOrEqual(512);
  });

  it("correlates server request resolution with the approval key, not its RPC id", () => {
    expect(
      parseCodexNotification(
        "serverRequest/resolved",
        { threadId: "thread-a", requestId: "approval-a" },
        "/workspace/project",
      ),
    ).toEqual({
      kind: "server-request-resolved",
      threadId: "thread-a",
      approvalKey: "approval-a",
    });
  });

  it("shows only canonical workspace locations for file approvals", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hype-codex-approval-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const parsed = parseCodexServerRequest(8, "item/fileChange/requestApproval", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-a",
        startedAtMs: 10,
        reason: null,
        grantRoot: null,
      });
      if (parsed.kind !== "file-approval") throw new Error("expected file approval");
      expect(codexApprovalTool(parsed, "local-item", workspace, ["src/app.ts"])).toMatchObject({
        title: "Change workspace files",
        locations: [{ path: "src/app.ts" }],
      });
      expect(() => codexApprovalTool(parsed, "local-item", workspace, [])).toThrow(
        CodexProtocolError,
      );
      expect(() => codexApprovalTool(parsed, "local-item", workspace, ["src/../app.ts"])).toThrow(
        CodexProtocolError,
      );
      expect(() =>
        codexApprovalTool(parsed, "local-item", workspace, ["escape/secret.txt"]),
      ).toThrow(CodexProtocolError);
      const outsideGrant = parseCodexServerRequest(9, "item/fileChange/requestApproval", {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-a",
        startedAtMs: 10,
        reason: null,
        grantRoot: outside,
      });
      if (outsideGrant.kind !== "file-approval") throw new Error("expected file approval");
      expect(() =>
        codexApprovalTool(outsideGrant, "local-item", workspace, ["src/app.ts"]),
      ).toThrow(CodexProtocolError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the exact candidate field matrix and strongest reviewed policy", () => {
    expect(codexThreadPolicy("/workspace/project")).toEqual({
      cwd: "/workspace/project",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(codexTurnPolicy("/workspace/project")).toEqual({
      cwd: "/workspace/project",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
  });
});
