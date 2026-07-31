import { useCallback, useId, useState, useSyncExternalStore } from "react";

import { themePreferenceSchema, type ThemePreference, type ThemeState } from "@hmm-chat/contracts";

import { BUILT_IN_THEME_OPTIONS, getThemeDefinition } from "../../shared/theme";
import type { ThemeRuntime } from "./theme-runtime";

interface ThemeSelectorProps {
  readonly theme: ThemeRuntime;
}

function resolvedDescription(state: ThemeState): string {
  const resolved = getThemeDefinition(state.resolvedThemeId).label;
  return state.preference === "system" ? `Following system · ${resolved}` : `${resolved} theme`;
}

export function ThemeSelector({ theme }: ThemeSelectorProps) {
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
        <select
          id={selectId}
          value={state.preference}
          disabled={saving}
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
    </div>
  );
}
