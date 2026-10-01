import path from "node:path";
import { rm, writeFile } from "node:fs/promises";

// Call only after the runner has stopped its Electron, server and PostgreSQL processes.
// Keep samples, logs, screenshots and CPU profiles available for inspection.
export async function removePerformanceRuntimeData(directory) {
  for (const name of ["postgres", "profiles", "callbacks"]) {
    await rm(path.join(directory, name), { recursive: true, force: true });
  }
}

// Preserve the scenario error and runtime data if shutdown or evidence persistence fails.
// Attempt result persistence even when stop() fails, and delete only after both succeed.
export async function finishPerformanceRuntime(
  { stop, directory, result, keepRuntimeData = false },
  scenarioError,
) {
  let cleanupError = null;
  const recordFailure = (error) => {
    cleanupError = error;
    result.status = "failed";
    result.cleanupError = error instanceof Error ? error.message : String(error);
    result.error =
      scenarioError === null
        ? result.cleanupError
        : scenarioError instanceof Error
          ? scenarioError.message
          : String(scenarioError);
  };
  const saveResults = async () => {
    await writeFile(path.join(directory, "results.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Results: ${directory}/results.json`);
  };
  try {
    await stop();
  } catch (error) {
    recordFailure(error);
  }
  try {
    await saveResults();
  } catch (error) {
    if (cleanupError === null) recordFailure(error);
    else console.error("Benchmark results could not be saved:", error);
  }
  if (cleanupError === null && !keepRuntimeData) {
    try {
      await removePerformanceRuntimeData(directory);
    } catch (error) {
      recordFailure(error);
      try {
        await saveResults();
      } catch (saveError) {
        console.error("Benchmark results could not be saved:", saveError);
      }
    }
  }
  if (cleanupError !== null) {
    if (scenarioError === null) throw cleanupError;
    console.error("Benchmark cleanup failed; runtime data retained:", cleanupError);
  }
}
