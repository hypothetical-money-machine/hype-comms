import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

import { resolveAgentWakePackageEvidence, resolveAgentWakeRollout } from "./agent-wake-rollout.mjs";
import { resolveDesktopBuildFlavor } from "./build-flavor.mjs";
import {
  DEFAULT_DEVELOPMENT_API_ORIGIN,
  DEFAULT_PRODUCTION_API_ORIGIN,
  normalizeDevelopmentApiOrigin,
  normalizeProductionApiOrigin,
} from "./src/shared/api-origin";
import {
  resolveMacosNativeNotificationEvidence,
  resolveNativeNotificationRollout,
} from "./src/shared/native-notification-rollout";
import {
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from "./src/shared/security-policy";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

const rendererDocumentMetadata = (isDevelopment: boolean, productName: string): Plugin => ({
  name: "hype-comms-renderer-document-metadata",
  transformIndexHtml(html) {
    const policy = isDevelopment
      ? DEVELOPMENT_CONTENT_SECURITY_POLICY
      : PRODUCTION_CONTENT_SECURITY_POLICY;

    return html
      .replace("__HYPE_COMMS_CONTENT_SECURITY_POLICY__", policy)
      .replace("__HYPE_COMMS_PRODUCT_NAME__", productName);
  },
});

export default defineConfig(({ command }) => {
  const isDevelopment = command === "serve";
  const buildFlavor = resolveDesktopBuildFlavor();
  // Native presentation stays compiled off unless an explicit development/test or native-evidence
  // build opts in. The terminal rollout may change this default only after packaged native proof.
  const nativeNotificationsEnabled = resolveNativeNotificationRollout(
    process.env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED,
  );
  const agentWakeEnabled = resolveAgentWakeRollout(process.env.HYPE_COMMS_AGENT_WAKE_ENABLED);
  const agentWakePackageEvidenceEnabled = resolveAgentWakePackageEvidence(
    process.env.HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED,
    agentWakeEnabled,
  );
  const macosNativeNotificationEvidenceEnabled = resolveMacosNativeNotificationEvidence(
    process.env.HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED,
    nativeNotificationsEnabled,
  );
  const configuredApiOrigin =
    process.env.HYPE_COMMS_API_ORIGIN ??
    (isDevelopment ? DEFAULT_DEVELOPMENT_API_ORIGIN : DEFAULT_PRODUCTION_API_ORIGIN);
  const apiOrigin = isDevelopment
    ? normalizeDevelopmentApiOrigin(configuredApiOrigin)
    : normalizeProductionApiOrigin(configuredApiOrigin);

  if (apiOrigin === null) {
    const requirement = isDevelopment
      ? "a credential-free loopback HTTP origin without a path"
      : "a credential-free HTTPS origin without a path";
    throw new Error(`HYPE_COMMS_API_ORIGIN must be ${requirement}`);
  }

  return {
    main: {
      define: {
        __HYPE_COMMS_APPLICATION_ID__: JSON.stringify(buildFlavor.appId),
        __HYPE_COMMS_AGENT_WAKE_ENABLED__: JSON.stringify(agentWakeEnabled),
        __HYPE_COMMS_AGENT_WAKE_PACKAGE_EVIDENCE_ENABLED__: JSON.stringify(
          agentWakePackageEvidenceEnabled,
        ),
        __HYPE_COMMS_API_ORIGIN__: JSON.stringify(apiOrigin),
        __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__: JSON.stringify(buildFlavor.protocolScheme),
        __HYPE_COMMS_BUILD_FLAVOR__: JSON.stringify(buildFlavor.name),
        __HYPE_COMMS_DESKTOP_NAME__: JSON.stringify(buildFlavor.desktopName),
        __HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED__: JSON.stringify(
          macosNativeNotificationEvidenceEnabled,
        ),
        __HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__: JSON.stringify(nativeNotificationsEnabled),
        __HYPE_COMMS_PRODUCT_NAME__: JSON.stringify(buildFlavor.productName),
        __HYPE_COMMS_PRODUCTION_CSP__: JSON.stringify(PRODUCTION_CONTENT_SECURITY_POLICY),
      },
      build: {
        outDir: path.join(desktopRoot, "dist/main"),
        rolldownOptions: {
          input: {
            index: path.join(desktopRoot, "src/main/index.ts"),
            "claude-acp-worker": path.join(desktopRoot, "src/main/claude-acp-worker.ts"),
            "codex-app-server-worker": path.join(
              desktopRoot,
              "src/main/codex-app-server-worker.ts",
            ),
          },
          output: {
            entryFileNames: "[name].js",
            format: "cjs",
          },
        },
      },
    },
    preload: {
      // The sandboxed preload cannot require arbitrary packages at runtime. Bundle the
      // validators used at the IPC boundary instead of externalizing them.
      build: {
        externalizeDeps: {
          exclude: ["@hype-comms/contracts", "zod"],
        },
        outDir: path.join(desktopRoot, "dist/preload"),
        rolldownOptions: {
          input: path.join(desktopRoot, "src/preload/index.ts"),
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    },
    renderer: {
      root: path.join(desktopRoot, "src/renderer"),
      base: "./",
      define: {
        __HYPE_COMMS_PRODUCT_NAME__: JSON.stringify(buildFlavor.productName),
      },
      plugins: [react(), rendererDocumentMetadata(isDevelopment, buildFlavor.productName)],
      server: {
        host: "127.0.0.1",
        port: 5173,
        strictPort: true,
      },
      build: {
        outDir: path.join(desktopRoot, "dist/renderer"),
        emptyOutDir: true,
      },
    },
  };
});
