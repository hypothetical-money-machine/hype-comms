import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  HttpClient,
  AttachmentClient,
  workspaceEndpoints as endpoints,
} from "../packages/api-client/dist/index.js";
import { z } from "zod";

import {
  productRealtimeEventSchema,
  entityIdSchema,
  sequenceSchema,
  sendConversationMessageRequestSchema,
} from "../packages/contracts/dist/index.js";
import { waitForReadiness } from "./rehearsal/wait-for-readiness.mjs";

const { WebSocket } = createRequire(new URL("../apps/server/package.json", import.meta.url))("ws");
const { values } = parseArgs({
  options: {
    "baseline-image": { type: "string" },
    "candidate-image": { type: "string" },
    "rollback-image": { type: "string" },
  },
});
assert.ok(
  values["baseline-image"] && values["candidate-image"] && values["rollback-image"],
  "Supply --baseline-image, --candidate-image and --rollback-image, all already built locally",
);

const prefix = `hype-cutover-rehearsal-${randomUUID()}`;
const pg = `${prefix}-postgres`;
const containers = [];
const volumes = [];
const directory = await mkdtemp(path.join(os.tmpdir(), "hype-cutover-rehearsal-"));
const resultPath = path.resolve(`.dev-data/rehearsal/server-cutover/${prefix}.json`);
let networkCreated = false;
let stage = "image inspection";

function docker(args, input) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      input,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // A child may hold an invitation URL, database credential or message body.
    throw new Error(`Docker failed during ${stage}`);
  }
}

async function eventually(check, timeoutMs = 30_000) {
  try {
    await waitForReadiness(check, { timeoutMs });
  } catch {
    throw new Error(`Readiness timed out during ${stage}`);
  }
}

function sql(database, statement) {
  return docker(
    [
      "exec",
      "-i",
      pg,
      "psql",
      "-XAt",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      "rehearsal",
      "--dbname",
      database,
    ],
    statement,
  );
}

function fingerprint(database) {
  const tables = sql(
    database,
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  ).split("\n");
  assert.ok(
    tables.length > 0 && tables[0] !== "",
    "No public tables found in database fingerprint",
  );
  return Object.fromEntries(
    tables.map((name) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return [
        name,
        sql(
          database,
          `SELECT count(*)::text || ':' || md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) FROM public.${quoted} AS t`,
        ),
      ];
    }),
  );
}

try {
  await rm(resultPath, { force: true });
  const baseline = docker(["image", "inspect", values["baseline-image"], "--format", "{{.Id}}"]);
  const candidate = docker(["image", "inspect", values["candidate-image"], "--format", "{{.Id}}"]);
  const rollback = docker(["image", "inspect", values["rollback-image"], "--format", "{{.Id}}"]);
  assert.notEqual(baseline, candidate, "The baseline must be the previous-release image");
  assert.notEqual(
    baseline,
    rollback,
    "The compatible rollback must differ from the previous release",
  );
  assert.notEqual(candidate, rollback, "Use a separately built compatible rollback image");
  docker(["image", "inspect", "postgres:16-alpine", "--format", "{{.Id}}"]);
  docker(["network", "create", prefix]);
  networkCreated = true;
  const password = randomUUID();
  const pgEnv = path.join(directory, "postgres.env");
  await writeFile(
    pgEnv,
    `POSTGRES_USER=rehearsal\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=rehearsal_source_test\n`,
    { mode: 0o600 },
  );
  stage = "isolated PostgreSQL startup";
  docker([
    "run",
    "--pull=never",
    "-d",
    "--name",
    pg,
    "--network",
    prefix,
    "--network-alias",
    "database",
    "--env-file",
    pgEnv,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "postgres:16-alpine",
  ]);
  containers.push(pg);
  await eventually(() =>
    docker([
      "exec",
      pg,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "rehearsal",
      "-d",
      "rehearsal_source_test",
    ]).includes("accepting connections"),
  );

  const envFiles = {};
  for (const suffix of ["source", "restored"]) {
    const volume = `${prefix}-${suffix}`;
    docker(["volume", "create", volume]);
    volumes.push(volume);
    const envFile = path.join(directory, `${suffix}.env`);
    await writeFile(
      envFile,
      [
        `HYPE_COMMS_DATABASE_URL=postgresql://rehearsal:${password}@database:5432/rehearsal_${suffix}_test`,
        "HYPE_COMMS_PUBLIC_API_URL=https://rehearsal.example.test",
        "HYPE_COMMS_EMAIL_DELIVERY=manual",
        "HYPE_COMMS_LOG_LEVEL=warn",
        "HYPE_COMMS_OWNER_EMAIL=rehearsal@example.test",
        "HYPE_COMMS_WORKSPACE_NAME=Cutover rehearsal",
        "HYPE_COMMS_WORKSPACE_SLUG=cutover-rehearsal",
        "HYPE_COMMS_AGENT_PROVISIONING_ENABLED=true",
        "HYPE_COMMS_DEFAULT_AGENT_AGENCY_ENABLED=true",
        "HYPE_COMMS_ATTACHMENT_DIR=/var/lib/hype-comms/attachments",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    envFiles[suffix] = envFile;
  }
  async function start(image, suffix, label) {
    const name = `${prefix}-${label}`;
    docker([
      "run",
      "--pull=never",
      "-d",
      "--name",
      name,
      "--network",
      prefix,
      "--env-file",
      envFiles[suffix],
      "--mount",
      `type=volume,source=${prefix}-${suffix},target=/var/lib/hype-comms/attachments`,
      "-p",
      "127.0.0.1::3000",
      image,
    ]);
    containers.push(name);
    const binding = docker(["port", name, "3000/tcp"]);
    assert.match(binding, /^127\.0\.0\.1:\d+$/u);
    const origin = `http://${binding}`;
    await eventually(
      async () => (await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) })).ok,
    );
    return { name, origin };
  }
  const clientFor = (origin, cookie) =>
    new HttpClient({
      origin,
      fetch,
      timeoutMs: 15_000,
      ...(cookie ? { credentialHeaders: () => ({ cookie }) } : {}),
    });
  stage = "previous-release startup and synthetic fixtures";
  const source = await start(baseline, "source", "initial");
  const fixture = z
    .object({
      cookie: z.string().min(1).max(4096),
      workspaceId: entityIdSchema,
      conversationId: entityIdSchema,
      syncSequence: sequenceSchema,
      acceptedBody: sendConversationMessageRequestSchema,
      acceptedMessageId: entityIdSchema,
      taskId: entityIdSchema,
      attachmentId: entityIdSchema,
      agentToken: z.string().min(1).max(4096),
    })
    .strict()
    .parse(
      JSON.parse(
        docker(
          ["exec", "-i", source.name, "node", "--input-type=module"],
          await readFile(
            new URL("./rehearsal/server-cutover-baseline.mjs", import.meta.url),
            "utf8",
          ),
        ),
      ),
    );
  const { cookie, conversationId } = fixture;
  const accepted = { message: { id: fixture.acceptedMessageId } };
  const upload = { attachment: { id: fixture.attachmentId } };
  const credential = { token: fixture.agentToken };
  let human;
  const send = (body, attachmentIds = [], threadRootId = null) => {
    const id = randomUUID();
    return {
      ...endpoints.sendMessage(conversationId, {
        clientMessageId: id,
        body,
        bodyFormat: "hype_comms_markdown_v1",
        threadRootId,
        mentionedUserIds: [],
        attachmentIds,
      }),
      headers: { "idempotency-key": id },
    };
  };
  const acceptedRequest = {
    ...endpoints.sendMessage(conversationId, fixture.acceptedBody),
    headers: { "idempotency-key": fixture.acceptedBody.clientMessageId },
  };
  const bytes = new TextEncoder().encode("Synthetic attachment 😀\n");

  stage = "stopped-writer database and attachment backup";
  docker(["stop", source.name]);
  assert.equal(docker(["inspect", source.name, "--format", "{{.State.Running}}"]), "false");
  const before = fingerprint("rehearsal_source_test");
  const migrationsBefore = sql(
    "rehearsal_source_test",
    "SELECT filename FROM schema_migrations ORDER BY filename",
  ).split("\n");
  assert.equal(
    sql(
      "rehearsal_source_test",
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name IN ('protocol_epoch', 'protocol_replay_floor')",
    ),
    "0",
    "Baseline already has the cutover schema",
  );
  assert.ok(!migrationsBefore.includes("0032_workspace_protocol_epoch.sql"));
  const stoppedSequence = sql(
    "rehearsal_source_test",
    `SELECT last_event_sequence FROM workspaces WHERE id = '${fixture.workspaceId}'::uuid`,
  );
  const preservedTables = [
    "messages",
    "tasks",
    "attachments",
    "device_sessions",
    "agent_tokens",
    "api_idempotency_records",
    "sync_events",
  ];
  const preservedBefore = Object.fromEntries(preservedTables.map((name) => [name, before[name]]));
  assert.ok(
    Object.values(preservedBefore).every((value) => value !== undefined),
    "Baseline preservation tables are missing",
  );
  docker([
    "exec",
    pg,
    "pg_dump",
    "--username",
    "rehearsal",
    "--dbname",
    "rehearsal_source_test",
    "--format=custom",
    "--file=/tmp/rehearsal.dump",
  ]);
  sql("postgres", "CREATE DATABASE rehearsal_restored_test");
  docker([
    "exec",
    pg,
    "pg_restore",
    "--username",
    "rehearsal",
    "--dbname",
    "rehearsal_restored_test",
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "/tmp/rehearsal.dump",
  ]);
  assert.deepEqual(fingerprint("rehearsal_restored_test"), before);
  docker([
    "run",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "--user",
    "0",
    "--mount",
    `type=volume,source=${prefix}-source,target=/source,readonly`,
    "--mount",
    `type=volume,source=${prefix}-restored,target=/restored`,
    candidate,
    "sh",
    "-ec",
    "tar -C /source -cf /tmp/attachments.tar .; tar -C /restored -xf /tmp/attachments.tar",
  ]);

  stage = "candidate migration of restored baseline";
  docker([
    "run",
    "--rm",
    "--pull=never",
    "--network",
    prefix,
    "--env-file",
    envFiles.restored,
    candidate,
    "node",
    "dist/db/migrate.js",
  ]);
  const migrationsAfter = sql(
    "rehearsal_restored_test",
    "SELECT filename FROM schema_migrations ORDER BY filename",
  ).split("\n");
  const appliedMigrations = migrationsAfter.filter(
    (filename) => !migrationsBefore.includes(filename),
  );
  assert.ok(
    appliedMigrations.includes("0032_workspace_protocol_epoch.sql"),
    "The candidate did not migrate a pre-cutover database",
  );
  const afterMigration = fingerprint("rehearsal_restored_test");
  assert.deepEqual(
    Object.fromEntries(preservedTables.map((name) => [name, afterMigration[name]])),
    preservedBefore,
  );
  const operator = (args) =>
    JSON.parse(
      docker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        prefix,
        "--env-file",
        envFiles.restored,
        candidate,
        "node",
        "dist/modules/workspace/protocol-epoch-cli.js",
        ...args,
      ]),
    );
  const inspected = operator(["inspect", "--workspace-id", fixture.workspaceId]);
  assert.equal(inspected.epoch, null);
  assert.equal(inspected.sequence, stoppedSequence);
  stage = "restartable epoch activation with writers stopped";
  const epoch = randomUUID();
  const activation = [
    "activate",
    "--workspace-id",
    fixture.workspaceId,
    "--expected-epoch",
    inspected.epoch ?? "none",
    "--expected-sequence",
    inspected.sequence,
    "--epoch",
    epoch,
    "--writers-stopped",
  ];
  const activated = operator(activation);
  assert.deepEqual(operator(activation), activated);

  stage = "restored candidate and post-cutover writes";
  const restored = await start(candidate, "restored", "candidate");
  human = clientFor(restored.origin, cookie);
  const bootstrap = await human.request(endpoints.bootstrap());
  assert.equal(bootstrap.syncCursor.epoch, epoch);
  const retry = await human.request(acceptedRequest);
  assert.equal(retry.message.id, accepted.message.id);
  assert.equal(retry.syncCursor.epoch, epoch);
  await assert.rejects(
    human.request(endpoints.sync({ epoch: randomUUID(), sequence: fixture.syncSequence })),
    (error) => error.kind === "http" && error.body.error.code === "CURSOR_EXPIRED",
  );
  async function verifyAttachment() {
    const downloaded = await new AttachmentClient(human).download({
      path: endpoints.attachmentContent(upload.attachment.id),
      maxBytes: 1024,
    });
    assert.deepEqual(downloaded.bytes, bytes);
  }
  await verifyAttachment();
  assert.ok(
    (await human.request(endpoints.tasks(conversationId, {}))).tasks.some(
      (row) => row.id === fixture.taskId,
    ),
    "The previous-release task was not retained",
  );
  assert.equal(
    (await fetch(`${restored.origin}/v1/bootstrap`, { headers: { cookie } })).status,
    426,
  );
  const postCutoverRequest = send("Retain this post-cutover reply", [], accepted.message.id);
  const postCutover = await human.request(postCutoverRequest);
  docker(["stop", restored.name]);
  stage = "compatible rollback without database restoration";
  const rolledBack = await start(rollback, "restored", "rollback");
  human = clientFor(rolledBack.origin, cookie);
  assert.equal((await human.request(postCutoverRequest)).message.id, postCutover.message.id);
  assert.equal((await human.request(acceptedRequest)).message.id, accepted.message.id);
  await verifyAttachment();
  const rollbackTask = await human.request({
    ...endpoints.createTask(conversationId, {
      title: "Task created after compatible rollback",
      sourceMessageId: postCutover.message.id,
    }),
    headers: { "idempotency-key": randomUUID() },
  });
  assert.ok(rollbackTask.task.id);
  const agentClient = new HttpClient({
    origin: rolledBack.origin,
    fetch,
    timeoutMs: 15_000,
    credentialHeaders: () => ({ authorization: `Bearer ${credential.token}` }),
  });
  assert.equal(
    (await agentClient.request(endpoints.bootstrap())).workspace.id,
    fixture.workspaceId,
  );
  assert.equal((await fetch(`${rolledBack.origin}/v1/bootstrap`)).status, 426);

  stage = "rollback realtime reconnect";
  let after = (await human.request(endpoints.bootstrap())).syncCursor;
  for (let index = 0; index < 2; index++) {
    const ticket = await human.request(endpoints.ticket());
    const url = new URL("/v2/realtime", rolledBack.origin);
    url.protocol = "ws:";
    url.searchParams.set("ticket", ticket.ticket);
    url.searchParams.set("after", JSON.stringify(after));
    const socket = new WebSocket(url, { origin: "app://bundle", maxPayload: 4 * 1024 * 1024 });
    const frames = [];
    socket.on("error", () => {});
    socket.on("message", (data) => {
      const parsed = productRealtimeEventSchema.safeParse(JSON.parse(data.toString()));
      if (parsed.success) frames.push(parsed.data);
    });
    try {
      await eventually(() => socket.readyState === WebSocket.OPEN);
      const sent = await human.request(send(`Reconnect ${index}`));
      await eventually(() =>
        frames.some(
          (frame) =>
            frame.type === "message.created" && frame.payload.message.id === sent.message.id,
        ),
      );
      after = sent.syncCursor;
    } finally {
      socket.terminate();
    }
  }
  // The accepted operation exists once after candidate and rollback retries.
  assert.equal(
    sql(
      "rehearsal_restored_test",
      `SELECT count(*) FROM messages WHERE id = '${accepted.message.id}'::uuid`,
    ),
    "1",
  );
  const result = {
    baselineImage: baseline,
    candidateImage: candidate,
    appliedMigrations,
    rollbackImage: rollback,
    completedAt: new Date().toISOString(),
    comparedTables: Object.keys(before).length,
    passed: [
      "previous-release protocol and pre-cutover schema",
      "candidate migration of restored baseline rows",
      "retained messages, tasks, attachments, credentials, receipts and events",
      "all restored table fingerprints",
      "stopped writer",
      "repeat epoch activation",
      "accepted send identity",
      "wrong epoch rejection",
      "attachment backup and authenticated download",
      "post-cutover message across compatible rollback",
      "human session and agent credential",
      "task mutation after rollback",
      "two realtime connections",
      "old endpoint rejection",
    ],
    limits:
      "Disposable synthetic PostgreSQL and Docker volumes. This does not prove the production backup destination, Kubernetes orchestration, installed desktop update, or Hermes framework lifecycle.",
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(
    `Server cutover rehearsal passed (${result.comparedTables} restored tables). Evidence: ${resultPath}`,
  );
} catch {
  console.error(
    `Server cutover rehearsal failed during ${stage}. Subprocess output withheld because it may contain credentials.`,
  );
  process.exitCode = 1;
} finally {
  stage = "disposable resource cleanup";
  let failed = false;
  for (const name of containers.reverse()) {
    try {
      docker(["rm", "-fv", name]);
    } catch {
      failed = true;
    }
  }
  for (const name of volumes) {
    try {
      docker(["volume", "rm", name]);
    } catch {
      failed = true;
    }
  }
  if (networkCreated) {
    try {
      docker(["network", "rm", prefix]);
    } catch {
      failed = true;
    }
  }
  await rm(directory, { recursive: true, force: true });
  if (failed) {
    await rm(resultPath, { force: true });
    console.error(`Cleanup incomplete for owned resources with prefix ${prefix}`);
    process.exitCode = 1;
  }
}
