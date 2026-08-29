import { describe, expect, it, vi } from "vitest";

import {
  appImageDesktopFileName,
  createAppImageDesktopFilePlan,
  queryProtocolHandlerBinding,
  quoteExecArgument,
  registerAppImageProtocolHandler,
  type LinuxProtocolRegistrationTarget,
} from "./linux-protocol-registration";

const PLAN_INPUT = {
  scheme: "hype-comms",
  installedDesktopName: "com.hypemm.hypecomms.desktop",
  productName: "Hype Comms",
  appImagePath: "/home/wren/Apps/Hype Comms.AppImage",
  homeDirectory: "/home/wren",
  xdgDataHome: undefined,
} as const;

function createTarget(
  commandResult: { exitCode: number | null; stdout: string } = { exitCode: 0, stdout: "" },
): LinuxProtocolRegistrationTarget & {
  readonly makeDirectory: ReturnType<typeof vi.fn>;
  readonly writeFile: ReturnType<typeof vi.fn>;
  readonly runCommand: ReturnType<typeof vi.fn>;
} {
  return {
    makeDirectory: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => commandResult),
  };
}

describe("appImageDesktopFileName", () => {
  it("derives a distinct user-level name for both flavors", () => {
    expect(appImageDesktopFileName("com.hypemm.hypecomms.desktop")).toBe(
      "com.hypemm.hypecomms.appimage.desktop",
    );
    expect(appImageDesktopFileName("hype-comms-dev.desktop")).toBe(
      "hype-comms-dev.appimage.desktop",
    );
  });

  it("never reuses the installed name, which would shadow the deb's system entry", () => {
    for (const installed of ["com.hypemm.hypecomms.desktop", "hype-comms-dev.desktop"]) {
      expect(appImageDesktopFileName(installed)).not.toBe(installed);
    }
  });
});

describe("createAppImageDesktopFilePlan", () => {
  it("targets the default XDG data home when the variable is unset", () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    expect(plan?.applicationsDirectory).toBe("/home/wren/.local/share/applications");
    expect(plan?.desktopFilePath).toBe(
      "/home/wren/.local/share/applications/com.hypemm.hypecomms.appimage.desktop",
    );
  });

  it("respects an explicit XDG_DATA_HOME", () => {
    const plan = createAppImageDesktopFilePlan({ ...PLAN_INPUT, xdgDataHome: "/custom/share" });
    expect(plan?.applicationsDirectory).toBe("/custom/share/applications");
  });

  it("writes a hidden URL-handler entry claiming the scheme", () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    expect(plan?.desktopFileContents).toContain("[Desktop Entry]");
    expect(plan?.desktopFileContents).toContain("Type=Application");
    expect(plan?.desktopFileContents).toContain("Name=Hype Comms");
    expect(plan?.desktopFileContents).toContain("NoDisplay=true");
    expect(plan?.desktopFileContents).toContain("Terminal=false");
    expect(plan?.desktopFileContents).toContain("MimeType=x-scheme-handler/hype-comms;");
    expect(plan?.desktopFileContents).toContain('Exec="/home/wren/Apps/Hype Comms.AppImage" %u');
  });

  it("derives the development MIME type from the development scheme", () => {
    const plan = createAppImageDesktopFilePlan({
      ...PLAN_INPUT,
      scheme: "hype-comms-dev",
      installedDesktopName: "hype-comms-dev.desktop",
    });
    expect(plan?.mimeType).toBe("x-scheme-handler/hype-comms-dev");
    expect(plan?.desktopFileName).toBe("hype-comms-dev.appimage.desktop");
  });

  it("accepts either the packaged entry or the self-registered one as bound", () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    expect(plan?.acceptedHandlers).toEqual([
      "com.hypemm.hypecomms.desktop",
      "com.hypemm.hypecomms.appimage.desktop",
    ]);
  });

  it("escapes Exec-reserved characters in the AppImage path", () => {
    const plan = createAppImageDesktopFilePlan({
      ...PLAN_INPUT,
      appImagePath: '/tmp/we"ird$pa`th.AppImage',
    });
    expect(plan?.desktopFileContents).toContain('Exec="/tmp/we\\"ird\\$pa\\`th.AppImage" %u');
    expect(quoteExecArgument("back\\slash")).toBe('"back\\\\slash"');
  });

  it("refuses an empty or newline-containing AppImage path", () => {
    expect(createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "" })).toBeNull();
    expect(
      createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "/tmp/a\nb.AppImage" }),
    ).toBeNull();
    expect(
      createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "/tmp/a\rb.AppImage" }),
    ).toBeNull();
  });
});

describe("registerAppImageProtocolHandler", () => {
  it("creates the directory, rewrites the entry, and claims the scheme in order", async () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    const target = createTarget();

    await registerAppImageProtocolHandler(plan, target);

    expect(target.makeDirectory).toHaveBeenCalledWith("/home/wren/.local/share/applications");
    expect(target.writeFile).toHaveBeenCalledWith(plan.desktopFilePath, plan.desktopFileContents);
    expect(target.runCommand.mock.calls).toEqual([
      ["xdg-mime", ["default", "com.hypemm.hypecomms.appimage.desktop", plan.mimeType]],
      ["update-desktop-database", ["/home/wren/.local/share/applications"]],
    ]);
    expect(target.makeDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      target.writeFile.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(target.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      target.runCommand.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });

  it("rewrites the entry on every registration so a moved AppImage heals itself", async () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    if (plan === null) throw new Error("expected a plan");
    const target = createTarget();

    await registerAppImageProtocolHandler(plan, target);
    await registerAppImageProtocolHandler(plan, target);

    expect(target.writeFile).toHaveBeenCalledTimes(2);
  });

  it("tolerates a failing desktop-database refresh", async () => {
    const plan = createAppImageDesktopFilePlan(PLAN_INPUT);
    if (plan === null) throw new Error("expected a plan");
    const target = createTarget();
    target.runCommand.mockImplementation(async (command: string) =>
      command === "update-desktop-database"
        ? { exitCode: null, stdout: "" }
        : { exitCode: 0, stdout: "" },
    );

    await expect(registerAppImageProtocolHandler(plan, target)).resolves.toBeUndefined();
  });
});

describe("queryProtocolHandlerBinding", () => {
  const ACCEPTED = ["com.hypemm.hypecomms.desktop", "com.hypemm.hypecomms.appimage.desktop"];
  const MIME = "x-scheme-handler/hype-comms";

  it("reports bound for the deb's installed entry", async () => {
    const target = createTarget({ exitCode: 0, stdout: "com.hypemm.hypecomms.desktop\n" });
    await expect(queryProtocolHandlerBinding(MIME, ACCEPTED, target)).resolves.toBe("bound");
    expect(target.runCommand).toHaveBeenCalledWith("xdg-mime", ["query", "default", MIME]);
  });

  it("reports bound for the self-registered AppImage entry", async () => {
    const target = createTarget({ exitCode: 0, stdout: "com.hypemm.hypecomms.appimage.desktop\n" });
    await expect(queryProtocolHandlerBinding(MIME, ACCEPTED, target)).resolves.toBe("bound");
  });

  it("reports unbound for a foreign handler", async () => {
    const target = createTarget({ exitCode: 0, stdout: "org.example.other.desktop\n" });
    await expect(queryProtocolHandlerBinding(MIME, ACCEPTED, target)).resolves.toBe("unbound");
  });

  it("reports unbound when no handler is registered", async () => {
    const target = createTarget({ exitCode: 0, stdout: "\n" });
    await expect(queryProtocolHandlerBinding(MIME, ACCEPTED, target)).resolves.toBe("unbound");
  });

  it("reports unknown when the query cannot run", async () => {
    await expect(
      queryProtocolHandlerBinding(MIME, ACCEPTED, createTarget({ exitCode: 4, stdout: "" })),
    ).resolves.toBe("unknown");
    await expect(
      queryProtocolHandlerBinding(MIME, ACCEPTED, createTarget({ exitCode: null, stdout: "" })),
    ).resolves.toBe("unknown");
  });
});
