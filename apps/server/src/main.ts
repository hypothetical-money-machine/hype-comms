import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Lifecycle } from "./lifecycle.js";
import { createLoggerOptions } from "./logging.js";
import { ChatStore } from "./modules/chat/store.js";
import { installGracefulShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle = new Lifecycle();
  const chat =
    config.chat.enabled && config.chat.accessCode !== undefined
      ? {
          accessCode: config.chat.accessCode,
          store: new ChatStore(config.chat.dataPath),
          cookieSecure: config.chat.cookieSecure,
        }
      : undefined;
  const app = await buildApp({
    logger: createLoggerOptions(config),
    lifecycle,
    allowedOrigins: config.allowedOrigins,
    ...(chat === undefined ? {} : { chat }),
    ...(config.webRoot === undefined ? {} : { webRoot: config.webRoot }),
  });

  const shutdown = installGracefulShutdown({
    app,
    lifecycle,
    timeoutMs: config.shutdownTimeoutMs,
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { publicApiUrl: config.publicApiUrl, allowedOrigins: config.allowedOrigins },
      "Server listening",
    );
  } catch (error) {
    shutdown.uninstall();
    app.log.fatal({ err: error }, "Server failed to start");
    await app.close();
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`${JSON.stringify({ level: "fatal", message })}\n`);
  process.exitCode = 1;
});
