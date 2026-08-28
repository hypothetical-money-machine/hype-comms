import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("agent wake main-process startup", () => {
  it("defers strict environment path resolution until guarded wake initialization", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const initializerStart = source.indexOf("async function initializeAgentWakeRuntime");
    const initializerEnd = source.indexOf("\nfunction createUpdateSource", initializerStart);
    const initializer = source.slice(initializerStart, initializerEnd);
    const guardStart = initializer.indexOf("try {");
    const guardEnd = initializer.indexOf("} catch {");

    expect(initializerStart).toBeGreaterThanOrEqual(0);
    expect(initializerEnd).toBeGreaterThan(initializerStart);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);
    for (const resolver of [
      "resolveAgentWakeConfigurationPath",
      "resolveAgentWakeOperatorRequestPath",
    ]) {
      const calls = [...source.matchAll(new RegExp(`${resolver}\\(\\{`, "gu"))];
      expect(calls).toHaveLength(1);
      const call = calls[0]?.index ?? -1;
      expect(call, `${resolver} must not run during module evaluation`).toBeGreaterThan(
        initializerStart,
      );
      expect(call, `${resolver} must remain inside guarded wake initialization`).toBeLessThan(
        initializerEnd,
      );
      expect(call - initializerStart).toBeGreaterThan(guardStart);
      expect(call - initializerStart).toBeLessThan(guardEnd);
    }
    expect(initializer.slice(guardEnd)).toContain(
      'reportMainProcessError("Agent wake startup configuration is invalid")',
    );

    const initialWindow = source.indexOf("await createMainWindow();");
    const wakeStartup = source.indexOf("agentWakeStartup = initializeAgentWakeRuntime();");
    expect(initialWindow).toBeGreaterThan(initializerEnd);
    expect(wakeStartup).toBeGreaterThan(initialWindow);
  });
});
