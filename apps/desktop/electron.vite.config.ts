import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

import {
  DEFAULT_DEVELOPMENT_API_ORIGIN,
  DEFAULT_PRODUCTION_API_ORIGIN,
  normalizeDevelopmentApiOrigin,
  normalizeProductionApiOrigin,
} from "./src/shared/api-origin";
import { resolveNativeNotificationRollout } from "./src/shared/native-notification-rollout";
import {
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from "./src/shared/security-policy";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));

const rendererContentSecurityPolicy = (isDevelopment: boolean): Plugin => ({
  name: "hmm-chat-renderer-content-security-policy",
  transformIndexHtml(html) {
    const policy = isDevelopment
      ? DEVELOPMENT_CONTENT_SECURITY_POLICY
      : PRODUCTION_CONTENT_SECURITY_POLICY;

    return html.replace("__HMM_CHAT_CONTENT_SECURITY_POLICY__", policy);
  },
});

export default defineConfig(({ command }) => {
  const isDevelopment = command === "serve";
  // Native presentation stays compiled off unless an explicit development/test or pilot build
  // opts in. The terminal rollout may change this default only after packaged native evidence.
  const nativeNotificationsEnabled = resolveNativeNotificationRollout(
    process.env.HMM_NATIVE_NOTIFICATIONS_ENABLED,
  );
  const configuredApiOrigin =
    process.env.HMM_CHAT_API_ORIGIN ??
    (isDevelopment ? DEFAULT_DEVELOPMENT_API_ORIGIN : DEFAULT_PRODUCTION_API_ORIGIN);
  const apiOrigin = isDevelopment
    ? normalizeDevelopmentApiOrigin(configuredApiOrigin)
    : normalizeProductionApiOrigin(configuredApiOrigin);

  if (apiOrigin === null) {
    const requirement = isDevelopment
      ? "a credential-free loopback HTTP origin without a path"
      : "a credential-free HTTPS origin without a path";
    throw new Error(`HMM_CHAT_API_ORIGIN must be ${requirement}`);
  }

  return {
    main: {
      define: {
        __HMM_CHAT_API_ORIGIN__: JSON.stringify(apiOrigin),
        __HMM_CHAT_NATIVE_NOTIFICATIONS_ENABLED__: JSON.stringify(nativeNotificationsEnabled),
        __HMM_CHAT_PRODUCTION_CSP__: JSON.stringify(PRODUCTION_CONTENT_SECURITY_POLICY),
      },
      build: {
        outDir: path.join(desktopRoot, "dist/main"),
        rolldownOptions: {
          input: path.join(desktopRoot, "src/main/index.ts"),
          output: {
            entryFileNames: "index.js",
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
          exclude: ["@hmm-chat/contracts", "zod"],
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
      plugins: [react(), rendererContentSecurityPolicy(isDevelopment)],
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
