import type { FastifyInstance } from "fastify";

import type { Lifecycle } from "./lifecycle.js";

interface ShutdownRuntime {
  once(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface ShutdownController {
  shutdown(signal: NodeJS.Signals): Promise<void>;
  uninstall(): void;
}

export function installGracefulShutdown(options: {
  app: FastifyInstance;
  lifecycle: Lifecycle;
  timeoutMs: number;
  runtime?: ShutdownRuntime;
  forceExit?: (code: number) => void;
}): ShutdownController {
  const runtime = options.runtime ?? process;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;

    shutdownPromise = (async () => {
      options.lifecycle.markDraining();
      options.app.log.info({ signal }, "Graceful shutdown started");
      const timeout = setTimeout(() => {
        options.app.log.fatal({ signal }, "Graceful shutdown timed out");
        forceExit(1);
      }, options.timeoutMs);
      timeout.unref();

      try {
        await options.app.close();
        options.app.log.info({ signal }, "Graceful shutdown complete");
      } catch (error) {
        options.app.log.error({ err: error, signal }, "Graceful shutdown failed");
        forceExit(1);
      } finally {
        clearTimeout(timeout);
      }
    })();

    return shutdownPromise;
  };

  const listeners = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>();
  for (const signal of signals) {
    const listener = (received: NodeJS.Signals) => void shutdown(received);
    listeners.set(signal, listener);
    runtime.once(signal, listener);
  }

  return {
    shutdown,
    uninstall() {
      for (const [signal, listener] of listeners) runtime.off(signal, listener);
    },
  };
}
