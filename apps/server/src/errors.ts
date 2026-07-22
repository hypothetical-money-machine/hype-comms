import type { ApiErrorCode, ApiErrorDetail, ApiErrorEnvelope } from "@hmm-chat/contracts";
import type { FastifyError, FastifyInstance } from "fastify";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function envelope(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details === undefined ? {} : { details: [...details] }),
    },
  };
}

function validationDetails(error: FastifyError): ApiErrorDetail[] | undefined {
  if (!Array.isArray(error.validation)) return undefined;

  return error.validation.map((issue) => ({
    field: issue.instancePath || issue.schemaPath,
    issue: issue.message ?? "Invalid value",
  }));
}

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && "validation" in error;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(envelope(request.id, "NOT_FOUND", "Route not found"));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      void reply
        .code(error.statusCode)
        .send(envelope(request.id, error.code, error.message, error.details));
      return;
    }

    if (isFastifyError(error) && error.validation) {
      void reply
        .code(400)
        .send(envelope(request.id, "BAD_REQUEST", "Invalid request", validationDetails(error)));
      return;
    }

    request.log.error({ err: error, requestId: request.id }, "Unhandled request error");
    void reply
      .code(500)
      .send(envelope(request.id, "INTERNAL_ERROR", "An unexpected error occurred"));
  });
}
