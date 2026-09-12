import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    hookTimeout: 30_000,
    testTimeout: 10_000,
  },
});
