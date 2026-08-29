import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  appImageDesktopFileName,
  createAppImageDesktopFilePlan,
  createLinuxProtocolRegistrationTarget,
  parseDesktopEntryExecPath,
  queryProtocolHandlerBinding,
  quoteExecArgument,
  registerAppImageProtocolHandler,
  userApplicationsDirectory,
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
  readonly readFile: ReturnType<typeof vi.fn>;
  readonly fileIsExecutable: ReturnType<typeof vi.fn>;
  readonly runCommand: ReturnType<typeof vi.fn>;
} {
  return {
    makeDirectory: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => null),
    fileIsExecutable: vi.fn(async () => false),
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

  describe("self-registered entry staleness", () => {
    const SELF_REGISTERED = {
      desktopFileName: "com.hypemm.hypecomms.appimage.desktop",
      desktopFilePath: "/home/wren/.local/share/applications/com.hypemm.hypecomms.appimage.desktop",
    };
    const ENTRY = 'Exec="/home/wren/Apps/Hype Comms.AppImage" %u\n';

    it("trusts the self-registered entry only while its Exec target is launchable", async () => {
      const target = createTarget({
        exitCode: 0,
        stdout: "com.hypemm.hypecomms.appimage.desktop\n",
      });
      target.readFile.mockResolvedValue(ENTRY);
      target.fileIsExecutable.mockResolvedValue(true);

      await expect(
        queryProtocolHandlerBinding(MIME, ACCEPTED, target, SELF_REGISTERED),
      ).resolves.toBe("bound");
      expect(target.readFile).toHaveBeenCalledWith(SELF_REGISTERED.desktopFilePath);
      expect(target.fileIsExecutable).toHaveBeenCalledWith("/home/wren/Apps/Hype Comms.AppImage");
    });

    it("reports unbound when the Exec target is missing, a directory, or not executable", async () => {
      const target = createTarget({
        exitCode: 0,
        stdout: "com.hypemm.hypecomms.appimage.desktop\n",
      });
      target.readFile.mockResolvedValue(ENTRY);
      target.fileIsExecutable.mockResolvedValue(false);

      await expect(
        queryProtocolHandlerBinding(MIME, ACCEPTED, target, SELF_REGISTERED),
      ).resolves.toBe("unbound");
    });

    it("reports unbound when the entry is unreadable or has no parseable Exec", async () => {
      const unreadable = createTarget({
        exitCode: 0,
        stdout: "com.hypemm.hypecomms.appimage.desktop\n",
      });
      await expect(
        queryProtocolHandlerBinding(MIME, ACCEPTED, unreadable, SELF_REGISTERED),
      ).resolves.toBe("unbound");

      const noExec = createTarget({
        exitCode: 0,
        stdout: "com.hypemm.hypecomms.appimage.desktop\n",
      });
      noExec.readFile.mockResolvedValue("[Desktop Entry]\nType=Application\n");
      await expect(
        queryProtocolHandlerBinding(MIME, ACCEPTED, noExec, SELF_REGISTERED),
      ).resolves.toBe("unbound");
    });

    it("does not read anything when the deb's installed entry is the default", async () => {
      const target = createTarget({ exitCode: 0, stdout: "com.hypemm.hypecomms.desktop\n" });

      await expect(
        queryProtocolHandlerBinding(MIME, ACCEPTED, target, SELF_REGISTERED),
      ).resolves.toBe("bound");
      expect(target.readFile).not.toHaveBeenCalled();
      expect(target.fileIsExecutable).not.toHaveBeenCalled();
    });
  });
});

describe("parseDesktopEntryExecPath", () => {
  it("undoes the quoting the plan writes, including escaped reserved characters", () => {
    expect(parseDesktopEntryExecPath('Exec="/home/wren/Apps/Hype Comms.AppImage" %u\n')).toBe(
      "/home/wren/Apps/Hype Comms.AppImage",
    );
    expect(parseDesktopEntryExecPath('Exec="/tmp/we\\"ird\\$pa\\`th.AppImage" %u')).toBe(
      '/tmp/we"ird$pa`th.AppImage',
    );
  });

  it("accepts an unquoted single-path Exec line", () => {
    expect(parseDesktopEntryExecPath("Exec=/opt/hype/hype-comms %u")).toBe("/opt/hype/hype-comms");
  });

  it("parses null for a missing, empty, or unterminated Exec", () => {
    expect(parseDesktopEntryExecPath("[Desktop Entry]\nType=Application\n")).toBeNull();
    expect(parseDesktopEntryExecPath("Exec=\n")).toBeNull();
    expect(parseDesktopEntryExecPath('Exec="/tmp/unterminated %u')).toBeNull();
  });
});

describe("createLinuxProtocolRegistrationTarget", () => {
  it("treats only a regular file with the execute bit as launchable", async () => {
    const target = createLinuxProtocolRegistrationTarget();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hype-protocol-target-"));
    try {
      const executable = path.join(scratch, "app.AppImage");
      const plain = path.join(scratch, "plain.AppImage");
      await fs.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
      await fs.writeFile(plain, "#!/bin/sh\n", { mode: 0o644 });

      await expect(target.fileIsExecutable(executable)).resolves.toBe(true);
      await expect(target.fileIsExecutable(plain)).resolves.toBe(false);
      await expect(target.fileIsExecutable(scratch)).resolves.toBe(false);
      await expect(target.fileIsExecutable(path.join(scratch, "gone.AppImage"))).resolves.toBe(
        false,
      );
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("reads files leniently and never rejects on a missing path", async () => {
    const target = createLinuxProtocolRegistrationTarget();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hype-protocol-target-"));
    try {
      const entry = path.join(scratch, "entry.desktop");
      await fs.writeFile(entry, "[Desktop Entry]\n", "utf8");
      await expect(target.readFile(entry)).resolves.toBe("[Desktop Entry]\n");
      await expect(target.readFile(path.join(scratch, "missing.desktop"))).resolves.toBeNull();
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("maps a spawn failure to a null exit code instead of rejecting", async () => {
    const target = createLinuxProtocolRegistrationTarget();
    await expect(
      target.runCommand("hype-comms-definitely-not-a-command", ["query"]),
    ).resolves.toEqual({ exitCode: null, stdout: "" });
  });
});

describe("userApplicationsDirectory", () => {
  it("prefers XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(userApplicationsDirectory("/home/wren", "/custom/share")).toBe(
      "/custom/share/applications",
    );
    expect(userApplicationsDirectory("/home/wren", undefined)).toBe(
      "/home/wren/.local/share/applications",
    );
    expect(userApplicationsDirectory("/home/wren", "")).toBe(
      "/home/wren/.local/share/applications",
    );
  });
});
