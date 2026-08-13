import { useCallback, useId, useState, useSyncExternalStore, type RefObject } from "react";

import {
  themePreferenceSchema,
  type ThemePreference,
  type ThemeState,
} from "@hype-comms/contracts";

import { BUILT_IN_THEME_OPTIONS, getThemeDefinition } from "../../shared/theme";
import type { ThemeRuntime } from "./theme-runtime";

interface ThemeSelectorProps {
  readonly theme: ThemeRuntime;
  readonly designButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly onDesign?: () => void;
}

function resolvedDescription(state: ThemeState): string {
  const resolved = getThemeDefinition(state.resolvedThemeId).label;
  const base =
    state.preference === "system" ? `Following system · ${resolved}` : `${resolved} theme`;
  return state.accentColor === null || state.accentColor === undefined
    ? base
    : `${base} · Custom accent`;
}

export function ThemeSelector({ theme, designButtonRef, onDesign }: ThemeSelectorProps) {
  const selectId = useId();
  const descriptionId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const subscribe = useCallback((listener: () => void) => theme.subscribe(listener), [theme]);
  const getSnapshot = useCallback(() => theme.state, [theme]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const choose = async (preference: ThemePreference): Promise<void> => {
    if (saving || preference === state.preference) return;
    setSaving(true);
    setError("");
    try {
      await theme.setPreference(preference);
    } catch {
      setError("Could not save the appearance preference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="theme-control">
      <label htmlFor={selectId}>Appearance</label>
      <div className="theme-control-row">
        {/* Disabling the select mid-save would blur it — losing the user's tab position and
            letting compact mode's chrome auto-hide under them — so re-entrancy is guarded in
            choose() instead. */}
        <select
          id={selectId}
          value={state.preference}
          aria-busy={saving}
          aria-describedby={descriptionId}
          onChange={(event) => {
            const parsed = themePreferenceSchema.safeParse(event.currentTarget.value);
            if (parsed.success) void choose(parsed.data);
          }}
        >
          <option value="system">System</option>
          {BUILT_IN_THEME_OPTIONS.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label}
            </option>
          ))}
        </select>
        <span id={descriptionId} className="theme-control-status" aria-live="polite">
          {saving ? "Saving…" : resolvedDescription(state)}
        </span>
      </div>
      {error !== "" && (
        <p className="theme-control-error" role="alert">
          {error}
        </p>
      )}
      {onDesign !== undefined && (
        <button
          ref={designButtonRef}
          type="button"
          className="theme-designer-open"
          aria-label="Design a theme"
          onClick={onDesign}
        >
          <span>
            <strong>Design a theme</strong>
            <small>Choose a foundation and make the accent your own.</small>
          </span>
          <b aria-hidden="true">›</b>
        </button>
      )}
    </div>
  );
}
