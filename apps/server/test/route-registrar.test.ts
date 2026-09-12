import Fastify from "fastify";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, registerErrorHandling } from "../src/errors.js";
import {
  RouteRegistrar,
  routeModule,
  validateRequest,
  type AuthenticationPolicy,
} from "../src/http/route-registrar.js";

const applications: ReturnType<typeof Fastify>[] = [];
function application() {
  const app = Fastify();
  registerErrorHandling(app);
  applications.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

const policy: AuthenticationPolicy<{ userId: string }, readonly ("read" | "write")[]> = {
  name: "test-credential",
  authenticate: async (request, scopes) => {
    if (request.headers.authorization !== "Bearer valid") {
      throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
    }
    if (scopes.includes("write") && request.headers["x-can-write"] !== "yes") {
      throw new ApiError(403, "FORBIDDEN", "Write permission is required");
    }
    return { userId: "user-1" };
  },
};

describe("route registration", () => {
  it("authenticates and checks declared scopes before schema validation or domain calls", async () => {
    const app = application();
    const parsed = vi.fn();
    const handler = vi.fn(() => ({ saved: true }));
    new RouteRegistrar(app).register({
      method: "POST",
      url: "/protected",
      policy,
      scopes: ["write"],
      request: {
        body: validateRequest(
          z
            .object({ count: z.number() })
            .strict()
            .transform((value) => {
              parsed();
              return value;
            }),
          "Invalid count",
        ),
      },
      handler,
    });
    for (const [headers, status, code] of [
      [{}, 401, "UNAUTHORIZED"],
      [{ authorization: "Bearer invalid" }, 401, "UNAUTHORIZED"],
      [{ authorization: "Bearer valid" }, 403, "FORBIDDEN"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/protected",
        headers,
        payload: { count: 1 },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code, requestId: expect.any(String) } });
    }
    expect(parsed).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    const invalid = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: "Bearer valid", "x-can-write": "yes" },
      payload: { count: "wrong" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { message: "Invalid count" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes parsed defaults and transforms to the handler while preserving response status", async () => {
    const app = application();
    await app.register(
      routeModule<{ prefix: string }>((routes) => {
        routes.register({
          method: "POST",
          url: "/items/:id",
          policy,
          scopes: [],
          request: {
            params: validateRequest(
              z.object({ id: z.coerce.number().int() }).strict(),
              "Invalid id",
            ),
            query: validateRequest(
              z.object({ limit: z.coerce.number().default(20) }).strict(),
              "Invalid query",
            ),
            body: validateRequest(z.object({ title: z.string().trim() }).strict(), "Invalid title"),
          },
          handler: ({ identity, input, reply }) => {
            expectTypeOf(input.params.id).toEqualTypeOf<number>();
            expectTypeOf(input.query.limit).toEqualTypeOf<number>();
            return reply.code(201).send({ userId: identity.userId, ...input });
          },
        });
      }),
      { prefix: "/v1" },
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/items/7",
      headers: { authorization: "Bearer valid" },
      payload: { title: " hello " },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      userId: "user-1",
      params: { id: 7 },
      query: { limit: 20 },
      body: { title: "hello" },
    });
    const strict = await app.inject({
      method: "POST",
      url: "/v1/items/7?unknown=1",
      headers: { authorization: "Bearer valid" },
      payload: { title: "hello" },
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.json()).toMatchObject({ error: { message: "Invalid query" } });
  });

  it("preserves conditional checks and declared validation precedence", async () => {
    const app = application();
    new RouteRegistrar(app).register({
      method: "POST",
      url: "/items/:id",
      policy,
      scopes: [],
      beforeValidation: ({ request, reply }) => {
        if (request.headers["x-blocked"] === "yes") {
          void reply.header("retry-after", "30");
          throw new ApiError(429, "RATE_LIMITED", "Too many requests");
        }
      },
      request: {
        body: validateRequest(z.object({ title: z.string() }).strict(), "Invalid title"),
        params: validateRequest(z.object({ id: z.string().uuid() }).strict(), "Invalid id"),
      },
      handler: () => {
        throw new Error("Domain code must not run");
      },
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/items/invalid",
      headers: { authorization: "Bearer valid", "x-blocked": "yes" },
      payload: {},
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("30");
    const invalid = await app.inject({
      method: "POST",
      url: "/items/invalid",
      headers: { authorization: "Bearer valid" },
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { message: "Invalid title" } });
  });

  it("validates credential inputs before consuming a single-use credential", async () => {
    const app = application();
    let consumed = false;
    const authenticate = vi.fn(async ({ body }: { body: { token: string } }) => {
      if (body.token !== "valid" || consumed)
        throw new ApiError(401, "UNAUTHORIZED", "Credential expired");
      consumed = true;
      return { userId: "user-1" };
    });
    const handler = vi.fn(({ identity }: { identity: { userId: string } }) => identity);
    new RouteRegistrar(app).registerCredential({
      method: "POST",
      url: "/exchange",
      scopes: [],
      beforeAuthentication: ({ reply }) => {
        void reply.header("cache-control", "no-store");
      },
      request: {
        body: validateRequest(
          z.object({ token: z.string() }).strict(),
          "Invalid credential request",
        ),
      },
      policy: { name: "single-use-credential", authenticate },
      handler,
    });
    const malformed = await app.inject({ method: "POST", url: "/exchange", payload: {} });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["cache-control"]).toBe("no-store");
    expect(authenticate).not.toHaveBeenCalled();
    const success = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { token: "valid" },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ userId: "user-1" });
    const reused = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { token: "valid" },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.headers["cache-control"]).toBe("no-store");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(["application/json", "text/plain", "application/octet-stream"])(
    "keeps %s upload bytes intact and enforces the body limit",
    async (contentType) => {
      const app = application();
      await app.register(
        routeModule(async (routes) => {
          await routes.rawBytes(16, (files) => {
            files.register({
              method: "PUT",
              url: "/bytes",
              bodyLimit: 16,
              policy,
              scopes: [],
              request: { body: validateRequest(z.instanceof(Buffer), "Expected raw file bytes") },
              handler: ({ input }) => ({ bytes: [...input.body] }),
            });
          });
        }),
      );
      const bytes = Buffer.from([0, 255, 123, 10, 42]);
      const response = await app.inject({
        method: "PUT",
        url: "/bytes",
        headers: { authorization: "Bearer valid", "content-type": contentType },
        payload: bytes,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ bytes: [...bytes] });
      const tooLarge = await app.inject({
        method: "PUT",
        url: "/bytes",
        headers: { authorization: "Bearer valid", "content-type": contentType },
        payload: Buffer.alloc(17),
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    },
  );
});
