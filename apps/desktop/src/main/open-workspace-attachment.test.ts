import { describe, expect, it, vi } from "vitest";
import { deferred } from "./test-support/deferred";
import { openWorkspaceAttachment } from "./open-workspace-attachment";
import { OwnedWorkspaceSession } from "./workspace-session-owner";

const FILE = { fileName: "a/b\\c.txt", bytes: Buffer.from([42]), contentType: "text/plain" };
function session(downloadFile = async () => FILE) {
  const lifetime = new OwnedWorkspaceSession<{ transport: { downloadFile: typeof downloadFile } }>({
    userId: "alice",
    workspaceId: "workspace",
    generation: 1,
  });
  lifetime.initialize(() => ({ transport: { downloadFile } }));
  return lifetime;
}
function files() {
  return {
    destination: vi.fn((_id: string, name: string) => name),
    write: vi.fn(async () => undefined),
    open: vi.fn(async () => ""),
  };
}
describe("native attachment opening", () => {
  it("sanitizes the filename and opens only after the download and write", async () => {
    const lifetime = session();
    const io = files();
    await expect(openWorkspaceAttachment(lifetime, "id", io)).resolves.toEqual({ opened: true });
    expect(io.destination).toHaveBeenCalledWith("id", "a_b_c.txt");
    expect(io.write).toHaveBeenCalledWith("a_b_c.txt", FILE.bytes);
    expect(io.open).toHaveBeenCalledWith("a_b_c.txt");
    await lifetime.dispose();
  });

  it("never writes or opens a download returned after replacement", async () => {
    const download = deferred<typeof FILE>();
    const lifetime = session(() => download.promise);
    const io = files();
    const opening = openWorkspaceAttachment(lifetime, "id", io);
    await lifetime.dispose();
    download.resolve(FILE);
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(io.write).not.toHaveBeenCalled();
    expect(io.open).not.toHaveBeenCalled();
  });

  it("never opens a file if the session retires during the disk write", async () => {
    const written = deferred<void>();
    const lifetime = session();
    const io = { ...files(), write: vi.fn(() => written.promise) };
    const opening = openWorkspaceAttachment(lifetime, "id", io);
    await vi.waitFor(() => expect(io.write).toHaveBeenCalledOnce());
    await lifetime.dispose();
    written.resolve();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(io.open).not.toHaveBeenCalled();
  });
});
