import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from "react";

import {
  themeAccentColorSchema,
  themeDesignSchema,
  type ThemePreference,
  type ThemeState,
} from "@hype-comms/contracts";

import {
  getThemeDefinition,
  getThemeDefinitionForState,
  themeCssVariable,
  THEME_ACCENT_PRESETS,
  THEME_TOKEN_NAMES,
} from "../../shared/theme";
import type { ThemeRuntime } from "./theme-runtime";

interface ThemeDesignerProps {
  readonly theme: ThemeRuntime;
  readonly onCancel: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onSaved: () => void;
}

type ThemeFoundation = "system" | "light" | "dark";

const THEME_FOUNDATIONS: readonly {
  readonly id: ThemeFoundation;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: "system", label: "System", description: "Match this device" },
  { id: "light", label: "Light", description: "Bright and crisp" },
  { id: "dark", label: "Dark", description: "Calm and focused" },
];

function asFoundation(preference: ThemePreference): ThemeFoundation {
  return preference === "light" || preference === "dark" ? preference : "system";
}

function resolvedThemeState(
  preference: ThemeFoundation,
  accentColor: string | null,
  current: ThemeState,
): ThemeState {
  const resolvedThemeId = preference === "system" ? current.resolvedThemeId : preference;
  const definition = getThemeDefinition(resolvedThemeId);
  return {
    preference,
    resolvedThemeId: definition.id,
    resolvedColorScheme: definition.colorScheme,
    accentColor,
  };
}

function previewStyle(state: ThemeState): CSSProperties {
  const definition = getThemeDefinitionForState(state);
  const properties = Object.fromEntries(
    THEME_TOKEN_NAMES.map((token) => [themeCssVariable(token), definition.tokens[token]]),
  );
  return {
    ...properties,
    colorScheme: definition.colorScheme,
  } as CSSProperties;
}

function defaultAccentFor(preference: ThemeFoundation, current: ThemeState): string {
  const resolvedThemeId = preference === "system" ? current.resolvedThemeId : preference;
  return getThemeDefinition(resolvedThemeId).tokens.borderAccent;
}

export function ThemeDesigner({
  theme,
  onCancel,
  onDirtyChange,
  onSavingChange,
  onSaved,
}: ThemeDesignerProps) {
  const validationId = useId();
  const subscribe = useCallback((listener: () => void) => theme.subscribe(listener), [theme]);
  const getSnapshot = useCallback(() => theme.state, [theme]);
  const liveState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const initialState = useRef(liveState).current;
  const initialPreference = asFoundation(initialState.preference);
  const [preference, setPreference] = useState<ThemeFoundation>(initialPreference);
  const [usesDefaultAccent, setUsesDefaultAccent] = useState(
    initialState.accentColor === null || initialState.accentColor === undefined,
  );
  const [accentInput, setAccentInput] = useState(
    initialState.accentColor ?? defaultAccentFor(initialPreference, initialState),
  );
  const [lastValidAccent, setLastValidAccent] = useState(
    initialState.accentColor ?? defaultAccentFor(initialPreference, initialState),
  );
  const [mobilePanel, setMobilePanel] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const parsedAccent = themeAccentColorSchema.safeParse(accentInput);
  const accentColor = usesDefaultAccent ? null : parsedAccent.success ? parsedAccent.data : null;
  const previewAccentColor = usesDefaultAccent
    ? null
    : parsedAccent.success
      ? parsedAccent.data
      : lastValidAccent;
  const design = themeDesignSchema.safeParse({ preference, accentColor });
  const canSave = !saving && parsedAccent.success && design.success;
  const dirtyAccent = usesDefaultAccent
    ? null
    : parsedAccent.success
      ? parsedAccent.data
      : accentInput;
  const dirty =
    preference !== initialPreference || dirtyAccent !== (initialState.accentColor ?? null);
  const previewState = useMemo(
    () => resolvedThemeState(preference, previewAccentColor, liveState),
    [liveState, preference, previewAccentColor],
  );
  const style = useMemo(() => previewStyle(previewState), [previewState]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const chooseFoundation = (next: ThemeFoundation): void => {
    setPreference(next);
    setError("");
    if (usesDefaultAccent) {
      const defaultAccent = defaultAccentFor(next, liveState);
      setAccentInput(defaultAccent);
      setLastValidAccent(defaultAccent);
    }
  };

  const chooseAccent = (color: string): void => {
    setUsesDefaultAccent(false);
    setAccentInput(color);
    setLastValidAccent(color);
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave || !design.success) return;
    setSaving(true);
    onSavingChange(true);
    setError("");
    try {
      await theme.setDesign(design.data);
      onSaved();
    } catch {
      setError("Could not save your theme. Your current appearance is unchanged.");
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  return (
    <form className="theme-designer" aria-busy={saving} onSubmit={(event) => void submit(event)}>
      <div className="theme-designer-mobile-tabs" role="group" aria-label="Designer view">
        <button
          type="button"
          disabled={saving}
          aria-pressed={mobilePanel === "edit"}
          onClick={() => setMobilePanel("edit")}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={saving}
          aria-pressed={mobilePanel === "preview"}
          onClick={() => setMobilePanel("preview")}
        >
          Preview
        </button>
      </div>

      <div className={`theme-designer-editor${mobilePanel === "edit" ? "" : " mobile-hidden"}`}>
        <div className="theme-designer-intro">
          <p>Build a look that feels like yours.</p>
          <span>Your draft stays in this preview until you save it.</span>
        </div>

        <fieldset className="theme-foundation-options">
          <legend>Foundation</legend>
          <div>
            {THEME_FOUNDATIONS.map((foundation) => (
              <label key={foundation.id} className="theme-foundation-option">
                <input
                  type="radio"
                  disabled={saving}
                  name="theme-foundation"
                  value={foundation.id}
                  checked={preference === foundation.id}
                  onChange={() => chooseFoundation(foundation.id)}
                />
                <span>
                  <strong>{foundation.label}</strong>
                  <small>{foundation.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="theme-accent-options">
          <legend>Accent</legend>
          <p>Choose a signature color. Hype Comms tunes each role for readable contrast.</p>
          <div className="theme-accent-presets" role="group" aria-label="Accent presets">
            {THEME_ACCENT_PRESETS.map((preset) => {
              const selected =
                !usesDefaultAccent &&
                parsedAccent.success &&
                parsedAccent.data.toLowerCase() === preset.color.toLowerCase();
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={saving}
                  className={selected ? "selected" : undefined}
                  aria-label={`${preset.label} accent`}
                  aria-pressed={selected}
                  title={preset.label}
                  onClick={() => chooseAccent(preset.color)}
                >
                  <span style={{ backgroundColor: preset.color }} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          <div className="theme-accent-custom">
            <label className="theme-color-well">
              <span>Custom</span>
              <input
                type="color"
                disabled={saving}
                aria-label="Choose a custom accent"
                value={parsedAccent.success ? parsedAccent.data : lastValidAccent}
                onChange={(event) => chooseAccent(event.currentTarget.value)}
              />
            </label>
            <label className="theme-hex-input">
              <span>Hex value</span>
              <input
                type="text"
                disabled={saving}
                aria-label="Accent hex value"
                value={accentInput}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!parsedAccent.success}
                aria-describedby={!parsedAccent.success ? validationId : undefined}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setUsesDefaultAccent(false);
                  setAccentInput(value);
                  const parsed = themeAccentColorSchema.safeParse(value);
                  if (parsed.success) setLastValidAccent(parsed.data);
                  setError("");
                }}
              />
            </label>
          </div>
          {!parsedAccent.success && (
            <p id={validationId} className="theme-designer-validation" role="alert">
              Enter a six-digit color such as {THEME_ACCENT_PRESETS[0]?.color}.
            </p>
          )}
          <button
            type="button"
            disabled={saving}
            className="theme-default-accent"
            aria-pressed={usesDefaultAccent}
            onClick={() => {
              const defaultAccent = defaultAccentFor(preference, liveState);
              setUsesDefaultAccent(true);
              setAccentInput(defaultAccent);
              setLastValidAccent(defaultAccent);
              setError("");
            }}
          >
            Use theme default
          </button>
        </fieldset>

        <div className="theme-designer-safety">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>Contrast-aware palette</strong>
            <p>Text, controls, focus rings, and highlights are derived from your accent.</p>
          </div>
        </div>
      </div>

      <aside
        className={`theme-preview-panel${mobilePanel === "preview" ? "" : " mobile-hidden"}`}
        aria-labelledby="theme-preview-title"
      >
        <header>
          <div>
            <p className="eyebrow">Live preview</p>
            <h3 id="theme-preview-title">
              {preference === "system" ? "System foundation" : `${preference} foundation`}
            </h3>
          </div>
          <span>
            {usesDefaultAccent
              ? "Default accent"
              : parsedAccent.success
                ? "Custom accent"
                : "Last valid accent"}
          </span>
        </header>

        <div className="theme-preview" style={style} aria-hidden="true">
          <div className="theme-preview-rail">
            <span>H</span>
            <i />
            <i />
          </div>
          <div className="theme-preview-sidebar">
            <div>
              <small>Workspace</small>
              <strong>Hype Comms</strong>
            </div>
            <p>Channels</p>
            <span># design</span>
            <span className="selected"># general</span>
            <span># launch-planning</span>
            <p>Direct messages</p>
            <span>● Claire</span>
          </div>
          <div className="theme-preview-conversation">
            <header>
              <div>
                <strong># general</strong>
                <small>Workspace-wide conversation</small>
              </div>
              <span>Chat</span>
            </header>
            <div className="theme-preview-messages">
              <article>
                <b aria-hidden="true">C</b>
                <div>
                  <strong>Claire</strong>
                  <small>10:42 AM</small>
                  <p>I gave our workspace a fresh new look.</p>
                  <span className="theme-preview-reaction">✨ 3</span>
                </div>
              </article>
              <article>
                <b aria-hidden="true">W</b>
                <div>
                  <strong>Woots</strong>
                  <small>10:43 AM</small>
                  <p>The new accent feels right at home.</p>
                </div>
              </article>
            </div>
            <footer>
              <span>Message # general</span>
              <b>Send</b>
            </footer>
          </div>
        </div>
      </aside>

      <footer className="theme-designer-actions">
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={!parsedAccent.success || !design.success}
          aria-disabled={saving ? true : undefined}
          aria-busy={saving}
        >
          {saving ? "Saving…" : "Save & apply"}
        </button>
        {error !== "" && (
          <p role="alert" className="theme-designer-error">
            {error}
          </p>
        )}
      </footer>
    </form>
  );
}
