import type { RealtimeConnectionState } from "../../shared/desktop-api";

interface ConversationHealthProps {
  readonly connection: RealtimeConnectionState;
  readonly stale: boolean;
  readonly cacheMode: "persistent" | "memory_only" | null;
  readonly notice: string | null;
  readonly onRetry: () => void;
  readonly onResetCache: () => void;
  readonly onCheckForUpdates: () => Promise<void>;
}

const connectionLabels: Readonly<Record<Exclude<RealtimeConnectionState, "live">, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  incompatible: "Live updates paused",
};

export function RealtimeIncompatibleNotice({
  onCheckForUpdates,
}: {
  readonly onCheckForUpdates: () => Promise<void>;
}) {
  return (
    <div className="realtime-incompatible" role="alert">
      <div>
        <strong>Desktop update may be required</strong>
        <span>
          Live updates are paused because the stream reported a state this version cannot safely
          apply. Your saved position is safe.
        </span>
      </div>
      <button className="quiet-button" type="button" onClick={() => void onCheckForUpdates()}>
        Check for updates
      </button>
    </div>
  );
}

export function ConversationHealth({
  connection,
  stale,
  cacheMode,
  notice,
  onRetry,
  onResetCache,
  onCheckForUpdates,
}: ConversationHealthProps) {
  const connectionLabel = connection === "live" ? null : connectionLabels[connection];
  const warnings = [
    stale ? "Showing cached messages; new activity may be delayed." : null,
    cacheMode === "memory_only" ? "Local history will not be saved on this device." : null,
    notice,
  ].filter((warning): warning is string => warning !== null);

  if (connectionLabel === null && warnings.length === 0) return null;

  return (
    <div className="conversation-health">
      {connectionLabel !== null && (
        <span
          className={`conversation-health-status connection-${connection}`}
          role="status"
          aria-live="polite"
        >
          {connectionLabel}
        </span>
      )}
      {connection === "incompatible" && (
        <RealtimeIncompatibleNotice onCheckForUpdates={onCheckForUpdates} />
      )}
      {warnings.length > 0 && (
        <div
          className={
            notice === null ? "conversation-health-banner" : "conversation-health-banner error"
          }
          role={notice === null ? "status" : "alert"}
        >
          <span>{warnings.join(" ")}</span>
          <div className="conversation-health-actions">
            <button className="quiet-button" type="button" onClick={onRetry}>
              Retry
            </button>
            {notice !== null ? (
              <button className="quiet-button" type="button" onClick={onResetCache}>
                Reset local cache
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
