import { useEffect, useId, useRef, useState } from "react";

import type { NotificationPreference, NotificationState } from "@hype-comms/contracts";

import type { NotificationTransport } from "../../shared/desktop-api";

interface NotificationSettingsProps {
  readonly transport: NotificationTransport | undefined;
}

type PendingOperation = "preference" | "refresh" | null;

const LOAD_ERROR = "Could not load notification settings.";
const SAVE_ERROR = "Could not save notification settings.";
const REFRESH_ERROR = "Could not refresh notification capability.";

function supportLabel(state: NotificationState): string {
  return state.nativeSupport === "supported" ? "Supported" : "Unsupported";
}

function permissionLabel(state: NotificationState): string {
  switch (state.osPermission) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    default:
      return "Unknown";
  }
}

function capabilityExplanation(state: NotificationState): string {
  if (state.nativeSupport === "unsupported") {
    return "Native notifications are unavailable in this installation.";
  }
  if (state.osPermission === "denied") {
    return "Permission and Do Not Disturb are managed by your operating system. Enable Hype Comms in system settings, then refresh capability.";
  }
  if (state.osPermission === "unknown") {
    return "Permission has not been confirmed. Hype Comms will not repeatedly prompt.";
  }
  return "Sound and Do Not Disturb are managed by your operating system.";
}

export function NotificationSettings({ transport }: NotificationSettingsProps) {
  const enabledId = useId();
  const previewId = useId();
  const previewDescriptionId = useId();
  const capabilityDescriptionId = useId();
  const [state, setState] = useState<NotificationState | null>(null);
  const [loading, setLoading] = useState(transport !== undefined);
  const [pending, setPending] = useState<PendingOperation>(null);
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const revisionRef = useRef(0);
  const pendingRef = useRef<PendingOperation>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    revisionRef.current = 0;
    pendingRef.current = null;
    setState(null);
    setPending(null);
    setError("");
    setLoading(transport !== undefined);
    if (transport === undefined) return;

    let active = true;
    // Subscribe before hydrating. A pushed state is newer than a get request that was already in
    // flight, so the request may fill an empty view but must never overwrite that push.
    const unsubscribe = transport.onNotificationStateChanged((next) => {
      if (!active || generation !== generationRef.current) return;
      revisionRef.current += 1;
      setState(next);
      setLoading(false);
      setError("");
    });
    const hydrationRevision = revisionRef.current;
    void transport
      .getNotificationState()
      .then((next) => {
        if (!active || generation !== generationRef.current) return;
        if (revisionRef.current === hydrationRevision) setState(next);
        setLoading(false);
      })
      .catch(() => {
        if (!active || generation !== generationRef.current) return;
        setLoading(false);
        setError(LOAD_ERROR);
      });

    return () => {
      active = false;
      if (generation === generationRef.current) generationRef.current += 1;
      pendingRef.current = null;
      unsubscribe();
    };
  }, [transport]);

  if (transport === undefined) {
    return (
      <p className="notification-settings-unavailable" role="status">
        Notifications are unavailable in this build.
      </p>
    );
  }

  const applyPreference = async (preference: NotificationPreference): Promise<void> => {
    if (pendingRef.current !== null) return;
    pendingRef.current = "preference";
    setPending("preference");
    setError("");
    const generation = generationRef.current;
    const revision = revisionRef.current;
    try {
      const next = await transport.setNotificationPreference(preference);
      if (generation !== generationRef.current) return;
      // A transport push that landed while the write was in flight is authoritative and newer.
      if (revisionRef.current === revision) setState(next);
    } catch {
      if (generation === generationRef.current) setError(SAVE_ERROR);
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  const refreshCapability = async (): Promise<void> => {
    if (pendingRef.current !== null) return;
    pendingRef.current = "refresh";
    setPending("refresh");
    setError("");
    const generation = generationRef.current;
    const revision = revisionRef.current;
    try {
      const next = await transport.refreshNotificationCapability();
      if (generation !== generationRef.current) return;
      if (revisionRef.current === revision) setState(next);
    } catch {
      if (generation === generationRef.current) setError(REFRESH_ERROR);
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };

  if (state === null) {
    return (
      <div className="notification-settings" aria-busy={loading}>
        <p className="notification-settings-loading" role="status">
          {loading ? "Loading notification settings…" : "Notification state is unavailable."}
        </p>
        <button
          type="button"
          className="notification-capability-refresh"
          aria-busy={pending === "refresh"}
          onClick={() => void refreshCapability()}
        >
          {pending === "refresh" ? "Refreshing…" : "Refresh capability"}
        </button>
        {error !== "" && (
          <p className="notification-settings-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const preference: NotificationPreference = {
    version: 1,
    devicePreference: state.devicePreference,
    contentPreviewPreference: state.contentPreviewPreference,
  };

  return (
    <div className="notification-settings" aria-busy={pending !== null}>
      <label className="notification-preference" htmlFor={enabledId}>
        <span>
          <strong>Enable notifications</strong>
          <small>On this device</small>
        </span>
        <input
          id={enabledId}
          type="checkbox"
          checked={state.devicePreference === "enabled"}
          aria-busy={pending === "preference"}
          onChange={(event) =>
            void applyPreference({
              ...preference,
              devicePreference: event.currentTarget.checked ? "enabled" : "disabled",
            })
          }
        />
      </label>

      <label className="notification-preference" htmlFor={previewId}>
        <span>
          <strong>Show message previews</strong>
          <small id={previewDescriptionId}>Off by default; otherwise only metadata is shown.</small>
        </span>
        <input
          id={previewId}
          type="checkbox"
          checked={state.contentPreviewPreference === "enabled"}
          aria-busy={pending === "preference"}
          aria-describedby={previewDescriptionId}
          onChange={(event) =>
            void applyPreference({
              ...preference,
              contentPreviewPreference: event.currentTarget.checked ? "enabled" : "disabled",
            })
          }
        />
      </label>

      <dl className="notification-capability" aria-describedby={capabilityDescriptionId}>
        <div>
          <dt>Native support</dt>
          <dd>{supportLabel(state)}</dd>
        </div>
        <div>
          <dt>OS permission</dt>
          <dd>{permissionLabel(state)}</dd>
        </div>
      </dl>
      <p id={capabilityDescriptionId} className="notification-capability-copy">
        {capabilityExplanation(state)}
      </p>
      <button
        type="button"
        className="notification-capability-refresh"
        aria-busy={pending === "refresh"}
        onClick={() => void refreshCapability()}
      >
        {pending === "refresh" ? "Refreshing…" : "Refresh capability"}
      </button>
      {error !== "" && (
        <p className="notification-settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
