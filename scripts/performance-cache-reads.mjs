/* global IDBObjectStore, IDBIndex */

export async function startCacheReadProbe(page) {
  await page.evaluate(() => {
    // Diagnostic only: retain store/index names, row counts and read timings, never values.
    // Installation is after firstWindow, so this cannot claim coverage of the entire launch.
    const reads = { installedAt: performance.now(), started: 0, entries: [] };
    const restore = [];
    globalThis.performanceCacheReads = reads;
    for (const Source of [IDBObjectStore, IDBIndex]) {
      const original = Source.prototype.getAll;
      restore.push(() => {
        Source.prototype.getAll = original;
      });
      Source.prototype.getAll = function (...args) {
        const startMs = performance.now();
        const request = Reflect.apply(original, this, args);
        reads.started += 1;
        const index = this instanceof IDBIndex ? this.name : null;
        const store = this instanceof IDBIndex ? this.objectStore.name : this.name;
        request.addEventListener("success", () => {
          reads.entries.push({
            store,
            index,
            startMs,
            ms: performance.now() - startMs,
            rows: request.result.length,
          });
        });
        return request;
      };
    }
    globalThis.restorePerformanceCacheReadProbe = () => restore.forEach((reset) => reset());
  });
}

export async function stopCacheReadProbe(page) {
  return page.evaluate(() => {
    globalThis.restorePerformanceCacheReadProbe();
    return { ...globalThis.performanceCacheReads, capturedAt: performance.now() };
  });
}
