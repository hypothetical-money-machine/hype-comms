// Benchmark-only server: real routes, PostgreSQL, authorization and realtime transport.
// No message bodies, credentials or query strings are sent to the measurement process.
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { buildApp } from "../apps/server/dist/app.js";
import { IdentityRepository } from "../apps/server/dist/modules/identity/repository.js";
import { IdentityService } from "../apps/server/dist/modules/identity/service.js";
import { SignInThrottle } from "../apps/server/dist/throttle.js";
import { WorkspaceRepository } from "../apps/server/dist/modules/workspace/repository.js";
import { RealtimeEventHub } from "../apps/server/dist/modules/realtime/hub.js";

const pool = new pg.Pool({ connectionString: process.env.HYPE_COMMS_DATABASE_URL, max: 10 });
const realtimeHub = new RealtimeEventHub(pool);
await realtimeHub.start();
const app = await buildApp({
  cookieSecure: false,
  allowedOrigins: ["app://bundle", "http://127.0.0.1:5173"],
  identity: {
    service: new IdentityService(
      new IdentityRepository(pool),
      {
        sendMagicLink: async () => {
          throw new Error("Benchmark cannot send email");
        },
      },
      new SignInThrottle(),
      () => new Date(),
      `http://127.0.0.1:${process.env.HYPE_COMMS_PORT}`,
    ),
  },
  workspace: { repository: new WorkspaceRepository(pool), realtimeHub },
});
const responseBytes = new WeakMap();
let holdMessageWrites = false;
const heldWrites = new Set();
process.on("message", (message) => {
  if (message?.type !== "hold-message-writes" || typeof message.hold !== "boolean") return;
  holdMessageWrites = message.hold;
  if (!holdMessageWrites) for (const release of heldWrites) release();
  process.send?.({ type: "message-writes-held", hold: holdMessageWrites });
});
app.addHook("onRequest", async (request) => {
  if (
    holdMessageWrites &&
    request.method === "POST" &&
    request.routeOptions.url?.endsWith("/conversations/:id/messages")
  ) {
    await new Promise((resolve) => {
      const release = () => {
        clearTimeout(timeout);
        heldWrites.delete(release);
        resolve();
      };
      const timeout = setTimeout(release, 10_000);
      heldWrites.add(release);
    });
  }
  const ms = Number(process.env.PERF_REQUEST_DELAY_MS ?? 0);
  if (ms > 0) await delay(ms);
});
app.addHook("onSend", async (request, _reply, payload) => {
  responseBytes.set(request, typeof payload === "string" ? Buffer.byteLength(payload) : 0);
  return payload;
});
app.addHook("onResponse", async (request, reply) => {
  process.send?.({
    type: "request",
    method: request.method,
    route: request.routeOptions.url,
    status: reply.statusCode,
    ms: reply.elapsedTime,
    bytes: responseBytes.get(request) ?? 0,
  });
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.HYPE_COMMS_PORT) });
process.send?.({ type: "ready" });
async function stop() {
  for (const release of heldWrites) release();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
