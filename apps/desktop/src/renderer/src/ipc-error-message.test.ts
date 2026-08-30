import { describe, expect, it } from "vitest";

import { ipcErrorMessage } from "./ipc-error-message";

describe("ipcErrorMessage", () => {
  it("keeps a direct application error", () => {
    expect(ipcErrorMessage(new Error("Workspace unavailable"), "Fallback")).toBe(
      "Workspace unavailable",
    );
  });

  it("removes Electron wrappers for standard and named errors", () => {
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'workspace:list': Error: Request failed"),
        "Fallback",
      ),
    ).toBe("Request failed");
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'workspace:list': WorkspaceRequestError: Owner required",
        ),
        "Fallback",
      ),
    ).toBe("Owner required");
  });

  it("uses the fallback for missing errors and schema diagnostics", () => {
    expect(ipcErrorMessage(null, "Fallback")).toBe("Fallback");
    expect(
      ipcErrorMessage(
        new Error('Error invoking remote method \'workspace:list\': ZodError: [{"code":"custom"}]'),
        "Fallback",
      ),
    ).toBe("Fallback");
    expect(ipcErrorMessage(new Error('[{"code":"custom"}]'), "Fallback")).toBe("Fallback");
  });
});
