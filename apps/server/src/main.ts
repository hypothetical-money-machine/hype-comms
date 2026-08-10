import type { Pool } from "pg";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { Lifecycle } from "./lifecycle.js";
import { createLoggerOptions } from "./logging.js";
import { MetricsRegistry } from "./metrics.js";
import { BotService } from "./modules/bots/service.js";
import {
  ConsoleEmailSender,
  ManualEmailSender,
  SmtpEmailSender,
  type EmailSender,
} from "./modules/identity/email.js";
import { IdentityRepository } from "./modules/identity/repository.js";
import { IdentityService } from "./modules/identity/service.js";
import { installGracefulShutdown } from "./shutdown.js";
import { SignInThrottle } from "./throttle.js";
import { RealtimeEventHub } from "./modules/realtime/hub.js";
import { WorkspaceRepository } from "./modules/workspace/repository.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const lifecycle = new Lifecycle();
  let pool: Pool | undefined;
  let metricsRegistry: MetricsRegistry | undefined;
  let startedRealtimeHub: RealtimeEventHub | undefined;
  let identity:
    | {
        readonly service: IdentityService;
        readonly botService: BotService;
        readonly selfServiceMagicLink: boolean;
        readonly agentProvisioningEnabled: boolean;
      }
    | undefined;
  let workspace:
    | { readonly repository: WorkspaceRepository; readonly realtimeHub: RealtimeEventHub }
    | undefined;

  try {
    if (config.database !== undefined) {
      const databasePool = createPool(config.database);
      pool = databasePool;
      metricsRegistry =
        config.metricsToken === undefined ? undefined : new MetricsRegistry(databasePool);
      await runMigrations(databasePool);
      lifecycle.addCheck("database", async () => {
        await databasePool.query("SELECT 1");
        return true;
      });

      const emailSender: EmailSender =
        config.emailDelivery === "manual"
          ? new ManualEmailSender()
          : config.emailDelivery === "smtp" && config.smtp !== undefined
            ? new SmtpEmailSender(config.smtp)
            : new ConsoleEmailSender(config.nodeEnv);
      const service = new IdentityService(
        new IdentityRepository(databasePool),
        emailSender,
        new SignInThrottle(),
        () => new Date(),
        config.publicApiUrl,
        metricsRegistry === undefined
          ? undefined
          : { tokenReuseDetected: () => metricsRegistry?.refreshTokenReuseDetected() },
      );
      if (config.owner !== undefined) await service.seedOwner(config.owner);
      identity = {
        service,
        botService: new BotService(databasePool),
        selfServiceMagicLink: config.emailDelivery !== "manual",
        agentProvisioningEnabled: config.agentProvisioningEnabled,
      };
      const repository = new WorkspaceRepository(databasePool, {
        announcementChannelsEnabled: config.announcementChannelsEnabled,
        onAnnouncementAudit: (record) => {
          process.stdout.write(`${JSON.stringify({ level: "info", ...record })}\n`);
        },
      });
      const realtimeHub = new RealtimeEventHub(databasePool);
      await realtimeHub.start();
      startedRealtimeHub = realtimeHub;
      workspace = { repository, realtimeHub };
    }
  } catch (error) {
    await startedRealtimeHub?.close();
    await pool?.end();
    throw error;
  }

  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    const metrics =
      config.metricsToken === undefined
        ? undefined
        : {
            registry: metricsRegistry ?? new MetricsRegistry(pool),
            token: config.metricsToken,
          };
    app = await buildApp({
      logger: createLoggerOptions(config),
      lifecycle,
      allowedOrigins: config.allowedOrigins,
      cookieSecure: config.cookieSecure,
      ...(metrics === undefined ? {} : { metrics }),
      ...(identity === undefined ? {} : { identity }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(config.webRoot === undefined ? {} : { webRoot: config.webRoot }),
    });
    if (pool !== undefined) {
      const databasePool = pool;
      app.addHook("onClose", async () => databasePool.end());
    }
    if (workspace !== undefined) {
      const repository = workspace.repository;
      const maintenance = setInterval(
        () => {
          void repository.deleteExpiredState().catch((error: unknown) => {
            app.log.error({ err: error }, "Workspace retention cleanup failed");
          });
        },
        60 * 60 * 1_000,
      );
      maintenance.unref();
      app.addHook("onClose", async () => clearInterval(maintenance));
    }
    if (identity !== undefined) {
      const service = identity.service;
      const tokenHistoryMaintenance = setInterval(
        () => {
          void service.deleteExpiredDeviceSessionTokenHistory().catch((error: unknown) => {
            app.log.error({ err: error }, "Device-session token history cleanup failed");
          });
        },
        60 * 60 * 1_000,
      );
      tokenHistoryMaintenance.unref();
      app.addHook("onClose", async () => clearInterval(tokenHistoryMaintenance));
    }
  } catch (error) {
    await startedRealtimeHub?.close();
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
