import type { Attachment, User } from "@hype-comms/contracts";

interface FilesViewProps {
  readonly conversationName: string;
  readonly files: readonly Attachment[];
  readonly members: readonly User[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpen: (attachmentId: string) => Promise<void>;
  readonly onOpenSource: (attachment: Attachment) => void;
}

function memberName(members: readonly User[], userId: string): string {
  return members.find((member) => member.id === userId)?.displayName ?? "Former member";
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) {
    const kilobytes = sizeBytes / 1024;
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : String(Math.round(kilobytes))} KB`;
  }
  const megabytes = sizeBytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : String(Math.round(megabytes))} MB`;
}

function fileDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function FilesView({
  conversationName,
  files,
  members,
  busy,
  error,
  onOpen,
  onOpenSource,
}: FilesViewProps) {
  return (
    <div className="files-view" aria-busy={busy}>
      <header className="files-view-header">
        <h3>Files in {conversationName}</h3>
        <p>Shared files from this conversation, newest first.</p>
      </header>
      {error !== null && (
        <p className="files-view-error" role="alert">
          {error}
        </p>
      )}
      {files.length === 0 ? (
        <p className="files-view-empty">
          {busy ? "Loading files…" : "No files have been shared here yet."}
        </p>
      ) : (
        <ul className="files-list">
          {files.map((file) => (
            <li key={file.id} className="files-list-item">
              <div className="files-list-meta">
                <strong className="files-list-name">{file.fileName}</strong>
                <span>
                  {memberName(members, file.uploadedBy)} · {formatFileSize(file.sizeBytes)} ·{" "}
                  {fileDate(file.createdAt)}
                </span>
              </div>
              <div className="files-list-actions">
                <button type="button" className="quiet-button" onClick={() => void onOpen(file.id)}>
                  Open
                </button>
                {file.messageId !== null && (
                  <button type="button" className="quiet-button" onClick={() => onOpenSource(file)}>
                    Show in chat
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
