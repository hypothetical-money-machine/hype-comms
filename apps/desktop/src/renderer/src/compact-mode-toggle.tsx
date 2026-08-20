import { useEffect, useId, useState } from "react";

import type { DesktopPlatform } from "../../shared/desktop-api";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { useCompactModeEnabled } from "./use-compact-mode-enabled";
import { compactModeShortcutLabel } from "./use-compact-chrome";

interface CompactModeToggleProps {
  readonly compactMode: CompactModeRuntime;
  readonly platform: DesktopPlatform;
}

export function CompactModeToggle({ compactMode, platform }: CompactModeToggleProps) {
  const checkboxId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const enabled = useCompactModeEnabled(compactMode);

  // A save that later succeeds elsewhere (the keyboard shortcut goes through the same runtime)
  // changes `enabled`, so the stale error clears; a failed save leaves `enabled` unchanged and
  // the error correctly stays up.
  useEffect(() => setError(""), [enabled]);

  const change = async (next: boolean): Promise<void> => {
    if (saving || next === enabled) return;
    setSaving(true);
    setError("");
    try {
      await compactMode.setEnabled(next);
    } catch {
      setError("Could not save the compact mode preference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="compact-mode-control">
      <label htmlFor={checkboxId}>
        {/* Disabling the checkbox mid-save would blur it and lose the user's tab position, so
            re-entrancy is guarded in change() instead. */}
        <input
          id={checkboxId}
          type="checkbox"
          checked={enabled}
          aria-busy={saving}
          onChange={(event) => void change(event.currentTarget.checked)}
        />
        Compact mode
      </label>
      <kbd>{compactModeShortcutLabel(platform)}</kbd>
      <p className="compact-mode-control-hint">
        Tighter message, sidebar, and chrome spacing. The rail and sidebar hide until you reveal
        them.
      </p>
      {error !== "" && (
        <p className="compact-mode-control-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
