import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ATTACHMENT_DIRECTORY = "/var/lib/hype-comms/attachments";

test("keeps attachment bytes on writable durable storage with a read-only server root", (t) => {
  const rendered = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      HYPE_COMMS_DATABASE_URL: "postgres://hype_comms:test@postgres:5432/hype_comms",
      HYPE_COMMS_POSTGRES_PASSWORD: "test",
    },
  });

  if (rendered.error?.code === "ENOENT") {
    t.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(rendered.status, 0, rendered.stderr);

  const compose = JSON.parse(rendered.stdout);
  const server = compose.services.server;
  assert.equal(server.read_only, true);
  assert.equal(server.environment.HYPE_COMMS_ATTACHMENT_DIR, ATTACHMENT_DIRECTORY);

  const attachmentMount = server.volumes.find((volume) => volume.target === ATTACHMENT_DIRECTORY);
  assert.deepEqual(attachmentMount, {
    type: "volume",
    source: "attachment-data",
    target: ATTACHMENT_DIRECTORY,
    volume: {},
  });
  assert.ok(compose.volumes[attachmentMount.source]);
});
