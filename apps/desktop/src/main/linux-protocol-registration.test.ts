import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  appImageDesktopFileName,
  createAppImageDesktopFilePlan,
  createLinuxProtocolRegistrationTarget,
  installAndQueryLinuxProtocolHandler,
  isEphemeralAppImageMountPath,
  isUsableDesktopExecPath,
  parseDesktopEntryExecPath,
  queryProtocolHandlerBinding,
  quoteExecArgument,
  registerAppImageProtocolHandler,
  resolveLinuxProtocolInstallExecutable,
  userApplicationsDirectory,
  type LinuxProtocolInstallInput,
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

const INSTALL_INPUT: LinuxProtocolInstallInput = {
  scheme: "hype-comms",
  installedDesktopName: "com.hypemm.hypecomms.desktop",
  productName: "Hype Comms",
  appImagePath: "/home/wren/Apps/Hype Comms.AppImage",
  packagedExecutablePath: "/tmp/.mount_HypeCoXXXXXX/hype-comms",
  appDir: "/tmp/.mount_HypeCoXXXXXX",
  homeDirectory: "/home/wren",
  xdgDataHome: undefined,
};

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
    expect(createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "   " })).toBeNull();
    expect(
      createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "/tmp/a\nb.AppImage" }),
    ).toBeNull();
    expect(
      createAppImageDesktopFilePlan({ ...PLAN_INPUT, appImagePath: "/tmp/a\rb.AppImage" }),
    ).toBeNull();
  });
});

describe("resolveLinuxProtocolInstallExecutable", () => {
  it("prefers a durable $APPIMAGE path over the packaged binary", () => {
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: "/home/wren/Apps/Hype Comms.AppImage",
        packagedExecutablePath: "/tmp/.mount_HypeCoXXXXXX/hype-comms",
        appDir: "/tmp/.mount_HypeCoXXXXXX",
      }),
    ).toEqual({
      status: "appimage",
      executablePath: "/home/wren/Apps/Hype Comms.AppImage",
    });
  });

  it("falls back to the packaged executable when $APPIMAGE is unset", () => {
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: undefined,
        packagedExecutablePath: "/home/wren/squashfs-root/hype-comms",
        appDir: undefined,
      }),
    ).toEqual({
      status: "packaged-executable",
      executablePath: "/home/wren/squashfs-root/hype-comms",
    });
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: "",
        packagedExecutablePath: "/home/wren/squashfs-root/hype-comms",
        appDir: undefined,
      }),
    ).toEqual({
      status: "packaged-executable",
      executablePath: "/home/wren/squashfs-root/hype-comms",
    });
  });

  it("does not fall back from a present-but-unusable $APPIMAGE onto the FUSE mount", () => {
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: "/tmp/a\nb.AppImage",
        packagedExecutablePath: "/tmp/.mount_HypeCoXXXXXX/hype-comms",
        appDir: "/tmp/.mount_HypeCoXXXXXX",
      }),
    ).toEqual({ status: "invalid-path" });
  });

  it("refuses an ephemeral AppImage mount when $APPIMAGE is missing", () => {
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: undefined,
        packagedExecutablePath: "/tmp/.mount_HypeCoXXXXXX/hype-comms",
        appDir: "/tmp/.mount_HypeCoXXXXXX",
      }),
    ).toEqual({ status: "no-durable-exec" });
    expect(
      resolveLinuxProtocolInstallExecutable({
        appImagePath: undefined,
        packagedExecutablePath: "/home/wren/squashfs-root/hype-comms",
        appDir: "/home/wren/squashfs-root",
      }),
    ).toEqual({ status: "no-durable-exec" });
  });
});

describe("isUsableDesktopExecPath", () => {
  it("rejects empty, whitespace-only, and newline-containing paths", () => {
    expect(isUsableDesktopExecPath("/home/wren/Apps/Hype Comms.AppImage")).toBe(true);
    expect(isUsableDesktopExecPath("")).toBe(false);
    expect(isUsableDesktopExecPath("   ")).toBe(false);
    expect(isUsableDesktopExecPath("/tmp/a\nb.AppImage")).toBe(false);
    expect(isUsableDesktopExecPath("/tmp/a\rb.AppImage")).toBe(false);
  });
});

describe("isEphemeralAppImageMountPath", () => {
  it("treats .mount_ segments and $APPDIR as ephemeral", () => {
    expect(isEphemeralAppImageMountPath("/tmp/.mount_HypeCoXXXXXX/hype-comms", undefined)).toBe(
      true,
    );
    expect(
      isEphemeralAppImageMountPath(
        "/home/wren/squashfs-root/hype-comms",
        "/home/wren/squashfs-root",
      ),
    ).toBe(true);
    expect(isEphemeralAppImageMountPath("/home/wren/Apps/Hype Comms.AppImage", undefined)).toBe(
      false,
    );
    expect(
      isEphemeralAppImageMountPath("/opt/Hype Comms/hype-comms", "/tmp/.mount_HypeCoXXXXXX"),
    ).toBe(false);
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

describe("installAndQueryLinuxProtocolHandler", () => {
  const MIME = "x-scheme-handler/hype-comms";
  const APPIMAGE_DESKTOP = "com.hypemm.hypecomms.appimage.desktop";
  const DESKTOP_PATH = "/home/wren/.local/share/applications/com.hypemm.hypecomms.appimage.desktop";

  function defaultCommand(
    command: string,
    commandArguments: readonly string[],
  ): { exitCode: number | null; stdout: string } {
    if (command === "xdg-mime" && commandArguments[0] === "query") {
      return { exitCode: 0, stdout: `${APPIMAGE_DESKTOP}\n` };
    }
    return { exitCode: 0, stdout: "" };
  }

  it("installs the AppImage handler into the session: desktop file, xdg-mime default, Exec %u", async () => {
    const target = createTarget();
    target.runCommand.mockImplementation(async (command, commandArguments) =>
      defaultCommand(command, commandArguments),
    );
    target.readFile.mockResolvedValue('Exec="/home/wren/Apps/Hype Comms.AppImage" %u\n');
    target.fileIsExecutable.mockResolvedValue(true);

    const result = await installAndQueryLinuxProtocolHandler(INSTALL_INPUT, target);

    expect(result.install).toBe("written");
    expect(result.binding).toBe("bound");
    expect(target.makeDirectory).toHaveBeenCalledWith("/home/wren/.local/share/applications");
    expect(target.writeFile).toHaveBeenCalledWith(
      DESKTOP_PATH,
      expect.stringContaining('Exec="/home/wren/Apps/Hype Comms.AppImage" %u'),
    );
    const written = target.writeFile.mock.calls[0]?.[1] ?? "";
    expect(written).toContain("MimeType=x-scheme-handler/hype-comms;");
    expect(written).toContain("[Desktop Entry]");
    expect(target.runCommand).toHaveBeenCalledWith("xdg-mime", ["default", APPIMAGE_DESKTOP, MIME]);
    expect(target.fileIsExecutable).toHaveBeenCalledWith("/home/wren/Apps/Hype Comms.AppImage");
  });

  it("installs a durable extracted binary when $APPIMAGE is unset and the scheme is unbound", async () => {
    const extracted = "/home/wren/squashfs-root/hype-comms";
    const target = createTarget();
    let queryCount = 0;
    target.runCommand.mockImplementation(async (command, commandArguments) => {
      if (command === "xdg-mime" && commandArguments[0] === "query") {
        queryCount += 1;
        return queryCount === 1
          ? { exitCode: 0, stdout: "\n" }
          : { exitCode: 0, stdout: `${APPIMAGE_DESKTOP}\n` };
      }
      return { exitCode: 0, stdout: "" };
    });
    target.readFile.mockResolvedValue(`Exec="${extracted}" %u\n`);
    target.fileIsExecutable.mockResolvedValue(true);

    const result = await installAndQueryLinuxProtocolHandler(
      {
        ...INSTALL_INPUT,
        appImagePath: undefined,
        packagedExecutablePath: extracted,
        appDir: undefined,
      },
      target,
    );

    expect(result.install).toBe("written");
    expect(result.binding).toBe("bound");
    expect(target.writeFile).toHaveBeenCalledWith(
      DESKTOP_PATH,
      expect.stringContaining(`Exec="${extracted}" %u`),
    );
    expect(target.runCommand).toHaveBeenCalledWith("xdg-mime", ["default", APPIMAGE_DESKTOP, MIME]);
  });

  it("does not steal a working deb handler when the extracted binary is the fallback", async () => {
    const target = createTarget();
    target.runCommand.mockImplementation(async (command, commandArguments) => {
      if (command === "xdg-mime" && commandArguments[0] === "query") {
        return { exitCode: 0, stdout: "com.hypemm.hypecomms.desktop\n" };
      }
      return { exitCode: 0, stdout: "" };
    });

    const result = await installAndQueryLinuxProtocolHandler(
      {
        ...INSTALL_INPUT,
        appImagePath: undefined,
        packagedExecutablePath: "/opt/Hype Comms/hype-comms",
        appDir: undefined,
      },
      target,
    );

    expect(result.install).toBe("skipped-already-bound");
    expect(result.binding).toBe("bound");
    expect(target.writeFile).not.toHaveBeenCalled();
    expect(target.runCommand).not.toHaveBeenCalledWith("xdg-mime", [
      "default",
      APPIMAGE_DESKTOP,
      MIME,
    ]);
  });

  it("still rewrites from $APPIMAGE when the deb entry is already the default", async () => {
    const target = createTarget();
    target.runCommand.mockImplementation(async (command, commandArguments) =>
      defaultCommand(command, commandArguments),
    );
    target.readFile.mockResolvedValue('Exec="/home/wren/Apps/Hype Comms.AppImage" %u\n');
    target.fileIsExecutable.mockResolvedValue(true);

    const result = await installAndQueryLinuxProtocolHandler(INSTALL_INPUT, target);

    expect(result.install).toBe("written");
    expect(target.writeFile).toHaveBeenCalled();
  });

  it("skips install for an extracted launch that is only an ephemeral FUSE mount", async () => {
    const target = createTarget({ exitCode: 0, stdout: "\n" });

    const result = await installAndQueryLinuxProtocolHandler(
      { ...INSTALL_INPUT, appImagePath: undefined },
      target,
    );

    expect(result.install).toBe("skipped-no-durable-exec");
    expect(result.binding).toBe("unbound");
    expect(target.writeFile).not.toHaveBeenCalled();
    expect(target.runCommand).toHaveBeenCalledWith("xdg-mime", ["query", "default", MIME]);
  });

  it("reports an unusable $APPIMAGE and still queries the binding", async () => {
    const onInvalidPath = vi.fn();
    const target = createTarget({ exitCode: 0, stdout: "\n" });

    const result = await installAndQueryLinuxProtocolHandler(
      { ...INSTALL_INPUT, appImagePath: "/tmp/a\nb.AppImage" },
      target,
      { onInvalidPath },
    );

    expect(result.install).toBe("skipped-invalid-path");
    expect(result.binding).toBe("unbound");
    expect(onInvalidPath).toHaveBeenCalledTimes(1);
    expect(target.writeFile).not.toHaveBeenCalled();
  });

  it("queries after a write failure so the sign-in card still gets a signal", async () => {
    const onRegisterError = vi.fn();
    const target = createTarget();
    target.writeFile.mockRejectedValue(new Error("disk full"));
    target.runCommand.mockImplementation(async (command, commandArguments) => {
      if (command === "xdg-mime" && commandArguments[0] === "query") {
        return { exitCode: 0, stdout: "\n" };
      }
      return { exitCode: 0, stdout: "" };
    });

    const result = await installAndQueryLinuxProtocolHandler(INSTALL_INPUT, target, {
      onRegisterError,
    });

    expect(result.install).toBe("failed");
    expect(result.binding).toBe("unbound");
    expect(onRegisterError).toHaveBeenCalledTimes(1);
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

describe("AppImage protocol install against a real applications directory", () => {
  it("writes the desktop file and claims xdg-mime default with Exec launching this AppImage", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hype-protocol-install-"));
    const applicationsDirectory = path.join(scratch, "applications");
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const real = createLinuxProtocolRegistrationTarget();
    const target: LinuxProtocolRegistrationTarget = {
      makeDirectory: real.makeDirectory,
      writeFile: real.writeFile,
      readFile: real.readFile,
      fileIsExecutable: real.fileIsExecutable,
      runCommand: async (command, commandArguments) => {
        commands.push({ command, args: commandArguments });
        if (command === "xdg-mime" && commandArguments[0] === "query") {
          return { exitCode: 0, stdout: "com.hypemm.hypecomms.appimage.desktop\n" };
        }
        return { exitCode: 0, stdout: "" };
      },
    };

    try {
      const appImagePath = path.join(scratch, "Hype Comms.AppImage");
      await fs.writeFile(appImagePath, "#!/bin/sh\n", { mode: 0o755 });

      const result = await installAndQueryLinuxProtocolHandler(
        {
          scheme: "hype-comms",
          installedDesktopName: "com.hypemm.hypecomms.desktop",
          productName: "Hype Comms",
          appImagePath,
          packagedExecutablePath: path.join(scratch, ".mount_fake", "hype-comms"),
          appDir: path.join(scratch, ".mount_fake"),
          homeDirectory: scratch,
          xdgDataHome: scratch,
        },
        target,
      );

      const desktopFilePath = path.join(
        applicationsDirectory,
        "com.hypemm.hypecomms.appimage.desktop",
      );
      const contents = await fs.readFile(desktopFilePath, "utf8");
      expect(result.install).toBe("written");
      expect(result.binding).toBe("bound");
      expect(contents).toContain("[Desktop Entry]");
      expect(contents).toContain("MimeType=x-scheme-handler/hype-comms;");
      expect(contents).toContain(`Exec=${quoteExecArgument(appImagePath)} %u`);
      expect(commands).toContainEqual({
        command: "xdg-mime",
        args: ["default", "com.hypemm.hypecomms.appimage.desktop", "x-scheme-handler/hype-comms"],
      });
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
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
