import { useCallback, useEffect, useId, useState } from "react";

import { memberTitleSchema } from "@hype-comms/contracts";
import type { User } from "@hype-comms/contracts";

interface ProfileSectionProps {
  readonly currentUser: User;
  readonly onUpdateProfile: (title: string | null) => Promise<void>;
}

type SaveStatus = "idle" | "loading" | "success";

const VALIDATION_ERROR = "Title must be 1–160 characters and cannot contain control characters.";

function profileErrorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message !== "" ? reason.message : fallback;
}

export function ProfileSection({ currentUser, onUpdateProfile }: ProfileSectionProps) {
  const titleId = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentUser.title ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(currentUser.title ?? "");
    }
  }, [currentUser.title, editing]);

  const startEditing = useCallback((): void => {
    setEditing(true);
    setStatus("idle");
    setError(null);
    setDraft(currentUser.title ?? "");
  }, [currentUser.title]);

  const cancelEditing = useCallback((): void => {
    setEditing(false);
    setStatus("idle");
    setError(null);
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    const parsed = memberTitleSchema.safeParse(draft);
    if (!parsed.success) {
      setError(VALIDATION_ERROR);
      return;
    }
    setError(null);
    setStatus("loading");
    try {
      await onUpdateProfile(parsed.data);
      setStatus("success");
      setEditing(false);
    } catch (reason) {
      setStatus("idle");
      setError(profileErrorMessage(reason, "Could not save title."));
    }
  }, [draft, onUpdateProfile]);

  const handleClear = useCallback(async (): Promise<void> => {
    setError(null);
    setStatus("loading");
    try {
      await onUpdateProfile(null);
      setStatus("success");
      setEditing(false);
    } catch (reason) {
      setStatus("idle");
      setError(profileErrorMessage(reason, "Could not clear title."));
    }
  }, [onUpdateProfile]);

  return (
    <div className="profile-section">
      {editing ? (
        <div className="profile-section-edit">
          <label htmlFor={titleId}>Title</label>
          <div className="profile-section-field">
            <input
              id={titleId}
              type="text"
              value={draft}
              maxLength={160}
              disabled={status === "loading"}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <button type="button" disabled={status === "loading"} onClick={() => void handleSave()}>
              {status === "loading" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={status === "loading"}
              onClick={() => void handleClear()}
            >
              Clear
            </button>
            <button type="button" disabled={status === "loading"} onClick={cancelEditing}>
              Cancel
            </button>
          </div>
          {error !== null && (
            <p id={errorId} className="profile-section-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="profile-section-read">
          <p>
            <span className="profile-section-label">Title: </span>
            {currentUser.title ?? "No title"}
          </p>
          <button type="button" onClick={startEditing}>
            Edit
          </button>
          {status === "success" && (
            <p className="profile-section-success" role="status">
              Saved.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
