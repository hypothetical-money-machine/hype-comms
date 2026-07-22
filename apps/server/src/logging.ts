import type { FastifyServerOptions } from "fastify";
import type { ServerConfig } from "./config.js";

type LoggerOptions = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

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
          path: request.url.split("?", 1)[0],
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
