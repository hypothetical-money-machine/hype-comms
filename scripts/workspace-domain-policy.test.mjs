import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("workspace operations cannot depend on HTTP errors or registration", async () => {
  for (const filePath of [
    "apps/server/src/modules/workspace/task-operations.ts",
    "apps/server/src/modules/workspace/future/operations.ts",
  ]) {
    for (const source of [
      'import { ApiError as Failure } from "../../errors.js"; export { Failure };',
      'export { ApiError } from "../../../errors.js";',
      'import { routeModule } from "../../http/route-registrar.js"; export { routeModule };',
      'import type { FastifyInstance } from "fastify"; export type Server = FastifyInstance;',
    ]) {
      const [result] = await eslint.lintText(source, { filePath });
      assert.ok(result.messages.some((message) => message.ruleId === "no-restricted-imports"));
    }
    const [allowed] = await eslint.lintText(
      'import { DomainError } from "../../domain-errors.js"; export { DomainError };',
      { filePath },
    );
    assert.equal(allowed.errorCount, 0);
  }
});

test("workspace routes can still report HTTP validation failures", async () => {
  const [result] = await eslint.lintText(
    'import { ApiError } from "../../errors.js"; export { ApiError };',
    { filePath: "apps/server/src/modules/workspace/routes.ts" },
  );
  assert.equal(result.errorCount, 0);
});
