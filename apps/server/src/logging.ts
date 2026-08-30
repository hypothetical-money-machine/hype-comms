import type { FastifyServerOptions } from "fastify";
import type { ServerConfig } from "./config.js";

type LoggerOptions = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

const INCOMING_WEBHOOK_PATH_PREFIX = "/v1/webhooks/incoming/";

export function redactedRequestPath(url: string): string {
  const path = url.split("?", 1)[0] ?? url;
  return path.startsWith(INCOMING_WEBHOOK_PATH_PREFIX)
    ? `${INCOMING_WEBHOOK_PATH_PREFIX}[REDACTED]`
    : path;
}

export function createLoggerOptions(config: Pick<ServerConfig, "logLevel">): LoggerOptions {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "authorization",
        "cookie",
        "token",
        "ticket",
        "*.token",
        "*.ticket",
        "*.password",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          path: redactedRequestPath(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
        };
      },
      res(response) {
        return { statusCode: response.statusCode };
      },
    },
  };
}
