import type { Pool } from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { Lifecycle } from "./lifecycle.js";
import { createLoggerOptions } from "./logging.js";
import { ChatStore } from "./modules/chat/store.js";
import { ConsoleEmailSender, SmtpEmailSender, type EmailSender } from "./modules/identity/email.js";
import { IdentityRepository } from "./modules/identity/repository.js";
import { IdentityService } from "./modules/identity/service.js";
import { installGracefulShutdown } from "./shutdown.js";
import { SignInThrottle } from "./throttle.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle = new Lifecycle();
  let pool: Pool | undefined;
  let identity: { readonly service: IdentityService } | undefined;

  try {
    if (config.database !== undefined) {
      const databasePool = createPool(config.database);
      pool = databasePool;
      await runMigrations(databasePool);
      lifecycle.addCheck("database", async () => {
        await databasePool.query("SELECT 1");
        return true;
      });

      const emailSender: EmailSender =
        config.smtp === undefined
          ? new ConsoleEmailSender(config.nodeEnv)
          : new SmtpEmailSender(config.smtp);
      const service = new IdentityService(
        new IdentityRepository(databasePool),
        emailSender,
        new SignInThrottle(),
        () => new Date(),
        config.publicApiUrl,
      );
      if (config.owner !== undefined) await service.seedOwner(config.owner);
      identity = { service };
    }
  } catch (error) {
    await pool?.end();
    throw error;
  }

  const chat =
    config.chat.enabled && config.chat.accessCode !== undefined
      ? {
          accessCode: config.chat.accessCode,
          store: new ChatStore(config.chat.dataPath),
        }
      : undefined;
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp({
      logger: createLoggerOptions(config),
      lifecycle,
      allowedOrigins: config.allowedOrigins,
      cookieSecure: config.cookieSecure,
      ...(chat === undefined ? {} : { chat }),
      ...(identity === undefined ? {} : { identity }),
      ...(config.webRoot === undefined ? {} : { webRoot: config.webRoot }),
    });
    if (pool !== undefined) {
      const databasePool = pool;
      app.addHook("onClose", async () => databasePool.end());
    }
  } catch (error) {
    await pool?.end();
    throw error;
  }

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
