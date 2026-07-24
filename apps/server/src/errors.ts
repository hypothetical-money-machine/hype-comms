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
  return error instanceof Error && ("validation" in error || "statusCode" in error);
}

/**
 * Fastify raises its own errors for malformed bodies, unsupported media types and oversized
 * payloads. They carry a 4xx `statusCode` but no `validation` array, so they must be translated
 * into the shared envelope instead of falling through to a 500.
 */
const CLIENT_ERRORS: ReadonlyMap<number, { code: ApiErrorCode; message: string }> = new Map([
  [400, { code: "BAD_REQUEST", message: "The request could not be parsed" }],
  [401, { code: "UNAUTHORIZED", message: "Authentication is required" }],
  [403, { code: "FORBIDDEN", message: "The request is not allowed" }],
  [404, { code: "NOT_FOUND", message: "Route not found" }],
  [405, { code: "BAD_REQUEST", message: "The method is not allowed for this route" }],
  [409, { code: "CONFLICT", message: "The request conflicts with existing state" }],
  [413, { code: "BAD_REQUEST", message: "The request body is too large" }],
  [415, { code: "BAD_REQUEST", message: "The content type is not supported" }],
  [429, { code: "RATE_LIMITED", message: "Too many requests" }],
]);

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

    // Client mistakes are expected traffic: answer with the shared envelope and keep them out of
    // the error stream so that genuine faults stay visible.
    if (isFastifyError(error)) {
      const statusCode = error.statusCode ?? 500;
      const clientError = CLIENT_ERRORS.get(statusCode);
      if (clientError !== undefined && statusCode >= 400 && statusCode < 500) {
        request.log.warn(
          { requestId: request.id, statusCode, errorCode: error.code },
          "Rejected client request",
        );
        void reply
          .code(statusCode)
          .send(envelope(request.id, clientError.code, clientError.message));
        return;
      }
    }

    request.log.error({ err: error, requestId: request.id }, "Unhandled request error");
    void reply
      .code(500)
      .send(envelope(request.id, "INTERNAL_ERROR", "An unexpected error occurred"));
  });
}
