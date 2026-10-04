export async function waitForReadiness(
  check,
  {
    timeoutMs = 30_000,
    clock = Date.now,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // A connection or process may not be ready yet.
    }
    await pause(100);
  }
  throw new Error("Readiness deadline expired");
}
