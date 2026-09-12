import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
const filePath = "apps/server/src/modules/workspace/routes.ts";

test("route modules cannot import an unrestricted Fastify registrar", async () => {
  for (const source of [
    'import type { FastifyPluginAsync } from "fastify"; export type Routes = FastifyPluginAsync;',
    'import type { FastifyInstance } from "fastify"; export type Server = FastifyInstance;',
    'import { RouteRegistrar } from "../../http/route-registrar.js"; export { RouteRegistrar };',
    'import Fastify from "fastify"; export const app = Fastify();',
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.ok(result.messages.some((message) => message.ruleId === "no-restricted-imports"));
  }
});

test("route modules can declare policies through the narrowed module interface", async () => {
  const [result] = await eslint.lintText(
    'import { routeModule } from "../../http/route-registrar.js"; export { routeModule };',
    { filePath },
  );
  assert.equal(result.errorCount, 0);
});
