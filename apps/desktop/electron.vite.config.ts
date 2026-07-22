import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

import {
  DEFAULT_DEVELOPMENT_API_ORIGIN,
  DEFAULT_PRODUCTION_API_ORIGIN,
  normalizeDevelopmentApiOrigin,
  normalizeProductionApiOrigin,
} from "./src/shared/api-origin";
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
      plugins: [externalizeDepsPlugin()],
      define: {
        __HMM_CHAT_API_ORIGIN__: JSON.stringify(apiOrigin),
        __HMM_CHAT_PRODUCTION_CSP__: JSON.stringify(PRODUCTION_CONTENT_SECURITY_POLICY),
      },
      build: {
        outDir: path.join(desktopRoot, "dist/main"),
        rollupOptions: {
          input: path.join(desktopRoot, "src/main/index.ts"),
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        outDir: path.join(desktopRoot, "dist/preload"),
        rollupOptions: {
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
