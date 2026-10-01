import { z } from "zod";
import { DESKTOP_INITIAL_CHANNELS } from "./channels";

/** Available synchronously before renderer startup. This port has no mutations or credentials. */
export interface DesktopInitialValues {
  readonly automationHeadless: boolean;
}

export interface DesktopInitialValueReader {
  sendSync(channel: typeof DESKTOP_INITIAL_CHANNELS.automationHeadless): unknown;
}

export function readDesktopInitialValues(ipc: DesktopInitialValueReader): DesktopInitialValues {
  return Object.freeze({
    automationHeadless: z
      .boolean()
      .parse(ipc.sendSync(DESKTOP_INITIAL_CHANNELS.automationHeadless)),
  });
}
