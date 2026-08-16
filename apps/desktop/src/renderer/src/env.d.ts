/// <reference types="vite/client" />

import type { DesktopApi } from "../../shared/desktop-api";

declare global {
  const __HYPE_COMMS_PRODUCT_NAME__: string;

  interface Window {
    readonly hypeComms: DesktopApi;
  }
}

export {};
