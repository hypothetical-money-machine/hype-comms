import type { OwnedWorkspaceSession } from "./workspace-session-owner";
import type { WorkspaceTransport } from "./workspace-transport";

/** Authorize each native side effect after the preceding asynchronous operation has finished. */
export async function openWorkspaceAttachment(
  session: Pick<
    OwnedWorkspaceSession<{ transport: Pick<WorkspaceTransport, "downloadFile"> }>,
    "run" | "assertActive"
  >,
  attachmentId: string,
  files: {
    destination: (id: string, fileName: string) => string;
    write: (destination: string, bytes: Uint8Array) => Promise<void>;
    open: (destination: string) => Promise<string>;
  },
): Promise<{ opened: true }> {
  const file = await session.run(({ transport }) => transport.downloadFile(attachmentId));
  session.assertActive();
  const destination = files.destination(attachmentId, file.fileName.replace(/[\\/]/g, "_"));
  await files.write(destination, file.bytes);
  session.assertActive();
  const error = await session.run(() => files.open(destination));
  if (error !== "") throw new Error(error);
  return { opened: true };
}
