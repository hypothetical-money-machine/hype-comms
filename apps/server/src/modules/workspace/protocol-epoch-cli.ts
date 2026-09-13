import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { entityIdSchema, sequenceSchema } from "@hype-comms/contracts";

import { loadConfig } from "../../config.js";
import { createPool } from "../../db/pool.js";
import { establishWorkspaceProtocolEpoch, inspectWorkspaceProtocol } from "./protocol-epoch.js";

const USAGE = `Usage: protocol:epoch inspect --workspace-id UUID
       protocol:epoch activate --workspace-id UUID --expected-epoch UUID|none --expected-sequence N --epoch UUID --writers-stopped

Save inspect output with the maintenance backup. Activate only with every product writer stopped.
Retain the chosen new epoch and expected position: an interrupted activation is retried unchanged.`;

export async function runProtocolEpochCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: {
    readonly stdout: Pick<NodeJS.WritableStream, "write">;
    readonly stderr: Pick<NodeJS.WritableStream, "write">;
  },
): Promise<number> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "workspace-id": { type: "string" },
        "expected-epoch": { type: "string" },
        "expected-sequence": { type: "string" },
        epoch: { type: "string" },
        "writers-stopped": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      output.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const command = positionals[0];
    if (positionals.length !== 1 || (command !== "inspect" && command !== "activate"))
      throw new Error(USAGE);
    const workspaceId = entityIdSchema.parse(values["workspace-id"]);
    let activation: Parameters<typeof establishWorkspaceProtocolEpoch>[1] | undefined;
    if (command === "activate") {
      if (values["writers-stopped"] !== true)
        throw new Error(
          "Activation requires --writers-stopped after all product writers have stopped",
        );
      activation = {
        workspaceId,
        expectedEpoch:
          values["expected-epoch"] === "none"
            ? null
            : entityIdSchema.parse(values["expected-epoch"]),
        expectedSequence: sequenceSchema.parse(values["expected-sequence"]),
        epoch: entityIdSchema.parse(values.epoch),
      };
    } else if (
      values.epoch !== undefined ||
      values["expected-epoch"] !== undefined ||
      values["expected-sequence"] !== undefined ||
      values["writers-stopped"] !== undefined
    ) {
      throw new Error("inspect accepts only --workspace-id");
    }
    const config = loadConfig(env);
    if (config.database === undefined) throw new Error("HYPE_COMMS_DATABASE_URL is required");
    pool = createPool(config.database);
    if (activation !== undefined) {
      const state = await establishWorkspaceProtocolEpoch(pool, activation);
      output.stdout.write(`${JSON.stringify({ workspaceId, ...state })}\n`);
    } else {
      const client = await pool.connect();
      try {
        output.stdout.write(
          `${JSON.stringify({ workspaceId, ...(await inspectWorkspaceProtocol(client, workspaceId)) })}\n`,
        );
      } finally {
        client.release();
      }
    }
    return 0;
  } catch (error) {
    output.stderr.write(
      `Protocol epoch command failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    return 1;
  } finally {
    await pool?.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  process.exitCode = await runProtocolEpochCli(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
