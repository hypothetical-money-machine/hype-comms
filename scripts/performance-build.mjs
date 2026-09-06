// Keep the normal build settings and renderer output, changing
// only the compiled API origin for this unpackaged, loopback-only benchmark.
import { resolveConfig } from "electron-vite";
import { build } from "vite";

const apiOrigin = process.env.PERF_API_ORIGIN;
const url = new URL(apiOrigin);
if (url.origin !== apiOrigin || url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
  throw new Error("Performance builds require a loopback HTTP origin");
}
process.env.NODE_ENV_ELECTRON_VITE = "production";
const { config } = await resolveConfig({}, "build", "production");
config.main.define.__HYPE_COMMS_API_ORIGIN__ = JSON.stringify(apiOrigin);
config.main.plugins = [
  {
    name: "performance-build-metadata",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-metadata.json",
        source: `${JSON.stringify({ apiOrigin })}\n`,
      });
    },
  },
  ...config.main.plugins.filter((plugin) => plugin?.name !== "hype-comms-desktop-build-metadata"),
];
for (const target of ["main", "preload", "renderer"]) await build(config[target]);
