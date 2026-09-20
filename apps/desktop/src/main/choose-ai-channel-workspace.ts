/** Resolve a native folder selection without disguising session cancellation as a file error. */
export async function chooseAiChannelWorkspace<T>(
  selectedPath: string,
  operations: {
    realpath: (path: string) => Promise<string>;
    stat: (path: string) => Promise<{ isDirectory(): boolean }>;
    assertCurrent: () => void;
    chooseWorkspace: (path: string) => Promise<T>;
  },
): Promise<T> {
  try {
    const workspacePath = await operations.realpath(selectedPath);
    if (!(await operations.stat(workspacePath)).isDirectory()) {
      throw new Error("Not a directory");
    }
    operations.assertCurrent();
    return await operations.chooseWorkspace(workspacePath);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The selected AI Channel folder is unavailable", { cause: error });
  }
}
