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
import { createWorkOSAuthKitIdentityProvider } from "./modules/identity/authkit-provider.js";
import {
  AuthKitRepository,
  deleteExpiredAuthKitState,
} from "./modules/identity/authkit-repository.js";
import { AuthKitService } from "./modules/identity/authkit-service.js";
import { createWorkOSWebhookProcessor } from "./modules/identity/authkit-webhook.js";
import { IdentityRepository } from "./modules/identity/repository.js";
import { IdentityService } from "./modules/identity/service.js";
import { AgentEnrollmentModule } from "./modules/identity/agent-enrollment.js";
import { installGracefulShutdown } from "./shutdown.js";
import { SignInThrottle } from "./throttle.js";
import { RealtimeEventHub } from "./modules/realtime/hub.js";
import { LocalAttachmentStore } from "./modules/workspace/file-store.js";
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
        readonly agentEnrollment: AgentEnrollmentModule;
        readonly botService: BotService;
        readonly selfServiceMagicLink: boolean;
        readonly agentProvisioningEnabled: boolean;
        readonly authKitAdmissionEnabled: boolean;
        readonly authKitService?: AuthKitService;
        readonly workosWebhookProcessor?: ReturnType<typeof createWorkOSWebhookProcessor>;
      }
    | undefined;
  let workspace:
    | { readonly repository: WorkspaceRepository; readonly realtimeHub: RealtimeEventHub }
    | undefined;

  try {
    if (config.database !== undefined) {
      const attachmentStore = new LocalAttachmentStore(config.attachmentDir);
      // Storage is part of the database-backed message contract. Check that the configured root
      // supports the real write/read/rename pattern before applying a migration. GitOps separately
      // proves that this path is backed by the intended durable volume.
      await attachmentStore.prepare();
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
        config.defaultAgentAgencyEnabled,
      );
      if (config.owner !== undefined) await service.seedOwner(config.owner);
      const authKitRepository =
        config.workos === undefined
          ? undefined
          : new AuthKitRepository(databasePool, config.workos.encryptionKey);
      const authKitService =
        config.workos === undefined || authKitRepository === undefined
          ? undefined
          : new AuthKitService({
              provider: createWorkOSAuthKitIdentityProvider(config.workos),
              repository: authKitRepository,
            });
      const workosWebhookProcessor =
        config.workos?.webhookSecret === undefined || authKitRepository === undefined
          ? undefined
          : createWorkOSWebhookProcessor({
              apiKey: config.workos.apiKey,
              clientId: config.workos.clientId,
              webhookSecret: config.workos.webhookSecret,
              store: authKitRepository,
            });
      identity = {
        service,
        agentEnrollment: new AgentEnrollmentModule(databasePool),
        botService: new BotService(databasePool),
        selfServiceMagicLink: config.emailDelivery !== "manual",
        agentProvisioningEnabled: config.agentProvisioningEnabled,
        authKitAdmissionEnabled: config.authKitAdmissionEnabled,
        ...(authKitService === undefined ? {} : { authKitService }),
        ...(workosWebhookProcessor === undefined ? {} : { workosWebhookProcessor }),
      };
      const repository = new WorkspaceRepository(databasePool, {
        announcementChannelsEnabled: config.announcementChannelsEnabled,
        attachmentStore,
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
      trustedProxies: config.trustedProxies,
      ...(metrics === undefined ? {} : { metrics }),
      ...(identity === undefined ? {} : { identity }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(config.webRoot === undefined ? {} : { webRoot: config.webRoot }),
    });
    if (pool !== undefined) {
      const databasePool = pool;
      app.addHook("onClose", async () => databasePool.end());
      const cleanAuthKitState = () => {
        void deleteExpiredAuthKitState(databasePool, new Date()).catch((error: unknown) => {
          app.log.error({ err: error }, "AuthKit state cleanup failed");
        });
      };
      // Retention must survive provider-secret removal and rollback. Migration 0017 exists on every
      // database-backed release that can execute this code, so cleanup needs no WorkOS client.
      cleanAuthKitState();
      const authKitStateMaintenance = setInterval(cleanAuthKitState, 60 * 60 * 1_000);
      authKitStateMaintenance.unref();
      app.addHook("onClose", async () => clearInterval(authKitStateMaintenance));
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

      const authKitService = identity.authKitService;
      if (authKitService !== undefined) {
        let reconciliationInFlight = false;
        const reconcileAuthKitSessions = () => {
          if (reconciliationInFlight) return;
          reconciliationInFlight = true;
          void authKitService
            .reconcileActiveSessions()
            .then((result) => {
              if (result.revoked > 0) {
                app.log.info(
                  { checked: result.checked, revoked: result.revoked },
                  "AuthKit session reconciliation revoked inactive local sessions",
                );
              }
              if (result.unavailableSubjects > 0) {
                app.log.warn(
                  { unavailableSubjects: result.unavailableSubjects },
                  "AuthKit session reconciliation preserved subjects with unavailable state",
                );
              }
            })
            .catch((error: unknown) => {
              app.log.error({ err: error }, "AuthKit session reconciliation failed");
            })
            .finally(() => {
              reconciliationInFlight = false;
            });
        };
        reconcileAuthKitSessions();
        const authKitSessionReconciliation = setInterval(reconcileAuthKitSessions, 60 * 60 * 1_000);
        authKitSessionReconciliation.unref();
        app.addHook("onClose", async () => clearInterval(authKitSessionReconciliation));
      }
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
      {
        publicApiUrl: config.publicApiUrl,
        allowedOrigins: config.allowedOrigins,
        trustedProxies: config.trustedProxies,
        authKitConfigured: config.workos !== undefined,
        authKitAdmissionEnabled: config.authKitAdmissionEnabled,
      },
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
