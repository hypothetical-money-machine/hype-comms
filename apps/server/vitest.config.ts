import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    hookTimeout: 30_000,
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          globalSetup: ["./test/support/require-database.ts"],
        },
      },
    ],
  },
});
