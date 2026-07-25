import { z } from "zod";

export const UPDATE_CHECK_ERROR_MESSAGE = "Could not check for updates. Try again.";
export const UPDATE_DOWNLOAD_ERROR_MESSAGE = "Could not download the update. Try again.";
export const UPDATE_INSTALL_ERROR_MESSAGE = "Could not install the update. Try again.";

const curatedUpdateErrorMessages: readonly string[] = [
  UPDATE_CHECK_ERROR_MESSAGE,
  UPDATE_DOWNLOAD_ERROR_MESSAGE,
  UPDATE_INSTALL_ERROR_MESSAGE,
];
const updateErrorMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((message) => curatedUpdateErrorMessages.includes(message));

export const updateVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

/**
 * Update state reported to the renderer over IPC. Feed URLs, downloaded file paths, signing
 * details, and updater diagnostics stay in the main process. In particular, the error message is
 * bounded so a raw electron-updater error cannot cross IPC; the main process maps failures to a
 * small set of curated messages.
 */
export const updateStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("idle") }).strict(),
  z.object({ status: z.literal("checking") }).strict(),
  z.object({ status: z.literal("available") }).strict(),
  z
    .object({
      status: z.literal("downloading"),
      percentage: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      version: updateVersionSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      message: updateErrorMessageSchema,
    })
    .strict(),
]);

export type UpdateState = z.infer<typeof updateStateSchema>;
