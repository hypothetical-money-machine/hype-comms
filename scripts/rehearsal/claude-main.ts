import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { createClaudeAcpHost } from "../../apps/desktop/src/main/claude-acp-host";

async function main() {
  const scope = process.env.HYPE_COMMS_REHEARSAL_DIRECTORY;
  const workerPath = process.env.HYPE_COMMS_REHEARSAL_CLAUDE_WORKER;
  if (
    scope === undefined ||
    workerPath === undefined ||
    !path.isAbsolute(scope) ||
    !path.isAbsolute(workerPath)
  ) {
    throw new Error("The Claude rehearsal requires its own temporary workspace and built worker");
  }
  app.setName("Hype Comms Claude Rehearsal");
  app.setPath("userData", path.join(scope, "electron"));
  await app.whenReady();
  let assistant = "";
  let unexpectedExit = false;
  const host = await createClaudeAcpHost(
    {
      onSessionUpdate: (notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
          assistant += update.content.text;
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onExit: () => {
        unexpectedExit = true;
      },
    },
    { workerPath },
  );
  const worker = app.getAppMetrics().find((item) => item.name === "Hype Comms Claude ACP");
  const proof: Record<string, unknown> = { initialized: true, workerObserved: true };
  try {
    assert.ok(worker, "Real utility worker was not visible");
    const session = await host.newSession(scope);
    assert.ok(session.sessionId);
    proof.sessionOpened = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      host.prompt(
        session.sessionId,
        "Reply with exactly HYPE_COMMS_CLAUDE_SMOKE_OK. Do not use tools or inspect any files.",
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Synthetic prompt timed out")), 60_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(response.stopReason, "end_turn");
    assert.ok(
      assistant.trim() === "HYPE_COMMS_CLAUDE_SMOKE_OK",
      "Claude returned an unexpected synthetic reply",
    );
    proof.syntheticPromptPassed = true;
    await host.close(session.sessionId);
    proof.sessionClosed = true;
  } finally {
    await host.dispose();
    await host.dispose();
  }
  assert.ok(worker);
  const deadline = Date.now() + 5000;
  while (app.getAppMetrics().some((item) => item.pid === worker.pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(
    !app.getAppMetrics().some((item) => item.pid === worker.pid),
    "Utility worker remained after disposal",
  );
  assert.ok(!unexpectedExit);
  proof.workerExited = true;
  proof.limit =
    "Real development Electron host and bundled worker with user-installed Claude; synthetic prompt and temporary workspace. Not packaged-app acceptance.";
  await writeFile(path.join(scope, "result.json"), JSON.stringify(proof, null, 2) + "\n");
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : "Claude smoke failed");
    app.exit(1);
  },
);
