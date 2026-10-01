import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
} from "fastify";
import type { WebSocket } from "ws";
import type { z } from "zod";

import { ApiError } from "../errors.js";

export interface AuthenticationPolicy<Identity, Scopes> {
  readonly name: string;
  readonly authenticate: (
    request: FastifyRequest,
    scopes: Scopes,
    reply: FastifyReply,
  ) => Promise<Identity>;
}

export interface RequestValidation<Value> {
  readonly schema: z.ZodType<Value>;
  readonly message: string | ((value: unknown, error: z.ZodError) => string | ApiError);
}

export function validateRequest<Value>(
  schema: z.ZodType<Value>,
  message: string | ((value: unknown, error: z.ZodError) => string | ApiError),
): RequestValidation<Value> {
  return { schema, message };
}

type RequestPart = "params" | "query" | "body" | "headers";
type RequestSchemas = Partial<Record<RequestPart, RequestValidation<unknown>>>;
export type ValidatedRequest<Schemas extends RequestSchemas> = {
  readonly [Part in keyof Schemas]: Schemas[Part] extends RequestValidation<infer Value>
    ? Value
    : never;
};

interface RouteContext<Identity, Schemas extends RequestSchemas> {
  readonly identity: Identity;
  readonly input: ValidatedRequest<Schemas>;
  readonly request: Omit<FastifyRequest, "params" | "query" | "body">;
  readonly reply: FastifyReply;
}

interface RouteDefinition<Identity, Scopes, Schemas extends RequestSchemas> {
  readonly method: HTTPMethods;
  readonly url: string;
  readonly policy: AuthenticationPolicy<Identity, Scopes>;
  readonly scopes: NoInfer<Scopes>;
  /** Only consumed request parts are declared; unconsumed parts retain their existing behavior. */
  readonly request: Schemas & Record<Exclude<keyof Schemas, RequestPart>, never>;
  readonly bodyLimit?: number;
  readonly logLevel?: "silent";
  /** For response headers or origin checks that precede credential validation. */
  readonly beforeAuthentication?: (context: {
    request: FastifyRequest;
    reply: FastifyReply;
  }) => void | Promise<void>;
  /** For conditional permissions or throttling that historically precedes input validation. */
  readonly beforeValidation?: (
    context: Omit<RouteContext<Identity, Schemas>, "input">,
  ) => void | Promise<void>;
  readonly handler: (context: RouteContext<Identity, Schemas>) => unknown | Promise<unknown>;
}

/** Credential endpoints validate the credential-bearing inputs before consuming them. */
interface CredentialRouteDefinition<Identity, Scopes, Schemas extends RequestSchemas> extends Omit<
  RouteDefinition<Identity, Scopes, Schemas>,
  "policy" | "beforeValidation"
> {
  readonly policy: {
    readonly name: string;
    readonly authenticate: (
      input: ValidatedRequest<NoInfer<Schemas>>,
      request: FastifyRequest,
      scopes: Scopes,
      reply: FastifyReply,
    ) => Promise<Identity>;
  };
}

function parseRequest<Schemas extends RequestSchemas>(
  schemas: Schemas,
  request: FastifyRequest,
): ValidatedRequest<Schemas> {
  const input: Partial<Record<RequestPart, unknown>> = {};
  // Declaration order preserves the route's existing precedence when several inputs are invalid.
  for (const part of Object.keys(schemas) as RequestPart[]) {
    const validation = schemas[part];
    if (validation === undefined) continue;
    const parsed = validation.schema.safeParse(request[part]);
    if (!parsed.success) {
      const failure =
        typeof validation.message === "string"
          ? validation.message
          : validation.message(request[part], parsed.error);
      throw typeof failure === "string" ? new ApiError(400, "BAD_REQUEST", failure) : failure;
    }
    input[part] = parsed.data;
  }
  // Each declared part was parsed by its own schema above; this cast preserves that key mapping.
  return input as ValidatedRequest<Schemas>;
}

/** A route module receives this interface instead of Fastify's unauthenticated shorthand methods. */
export class RouteRegistrar {
  constructor(private readonly app: FastifyInstance) {}

  register<Identity, Scopes, const Schemas extends RequestSchemas>(
    definition: RouteDefinition<Identity, Scopes, Schemas>,
  ): void {
    this.app.route({
      method: definition.method,
      url: definition.url,
      ...(definition.bodyLimit === undefined ? {} : { bodyLimit: definition.bodyLimit }),
      ...(definition.logLevel === undefined ? {} : { logLevel: definition.logLevel }),
      config: { authenticationPolicy: definition.policy.name, staticScopes: definition.scopes },
      handler: async (request, reply) => {
        await definition.beforeAuthentication?.({ request, reply });
        const identity = await definition.policy.authenticate(request, definition.scopes, reply);
        await definition.beforeValidation?.({ identity, request, reply });
        const input = parseRequest(definition.request, request);
        return definition.handler({ identity, input, request, reply });
      },
    });
  }

  registerCredential<Identity, Scopes, const Schemas extends RequestSchemas>(
    definition: CredentialRouteDefinition<Identity, Scopes, Schemas>,
  ): void {
    this.app.route({
      method: definition.method,
      url: definition.url,
      ...(definition.bodyLimit === undefined ? {} : { bodyLimit: definition.bodyLimit }),
      ...(definition.logLevel === undefined ? {} : { logLevel: definition.logLevel }),
      config: { authenticationPolicy: definition.policy.name, staticScopes: definition.scopes },
      handler: async (request, reply) => {
        await definition.beforeAuthentication?.({ request, reply });
        const input = parseRequest(definition.request, request);
        const identity = await definition.policy.authenticate(
          input,
          request,
          definition.scopes,
          reply,
        );
        return definition.handler({ identity, input, request, reply });
      },
    });
  }

  websocket<Identity, Scopes, const Schemas extends RequestSchemas>(
    definition: Omit<CredentialRouteDefinition<Identity, Scopes, Schemas>, "method" | "handler"> & {
      readonly handler: (socket: WebSocket, context: RouteContext<Identity, Schemas>) => void;
    },
  ): void {
    const contexts = new WeakMap<FastifyRequest, RouteContext<Identity, Schemas>>();
    this.app.get(
      definition.url,
      {
        websocket: true,
        config: { authenticationPolicy: definition.policy.name, staticScopes: definition.scopes },
        preValidation: async (request, reply) => {
          await definition.beforeAuthentication?.({ request, reply });
          const input = parseRequest(definition.request, request);
          const identity = await definition.policy.authenticate(
            input,
            request,
            definition.scopes,
            reply,
          );
          contexts.set(request, { identity, input, request, reply });
        },
      },
      (socket, request) => {
        const context = contexts.get(request);
        if (context === undefined) {
          socket.close(1011, "Authentication context unavailable");
          return;
        }
        contexts.delete(request);
        definition.handler(socket, context);
      },
    );
  }

  /** Signature verification needs the original JSON text, without parsing or reserialization. */
  async rawJsonText(bodyLimit: number, setup: (routes: RouteRegistrar) => void): Promise<void> {
    await this.app.register(async (webhooks) => {
      webhooks.removeContentTypeParser("application/json");
      webhooks.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit },
        (_request, body, done) => done(null, body),
      );
      setup(new RouteRegistrar(webhooks));
    });
  }

  /** The attachment lane must override JSON/text parsers as well as the wildcard parser. */
  async rawBytes(bodyLimit: number, setup: (routes: RouteRegistrar) => void): Promise<void> {
    await this.app.register(async (files) => {
      files.removeAllContentTypeParsers();
      files.addContentTypeParser("*", { parseAs: "buffer", bodyLimit }, (_request, body, done) => {
        done(null, body);
      });
      setup(new RouteRegistrar(files));
    });
  }
}

export function routeModule<Options extends object>(
  setup: (routes: RouteRegistrar, options: Options) => void | Promise<void>,
): FastifyPluginAsync<Options> {
  return async (app, options) => setup(new RouteRegistrar(app), options);
}
