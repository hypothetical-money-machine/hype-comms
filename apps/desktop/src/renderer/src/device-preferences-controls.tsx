import type { DevicePreferences } from "@hype-comms/contracts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { DesktopPlatform } from "../../shared/desktop-api";
import {
  useDevicePreferences,
  type DevicePreferencesControlRuntime,
} from "./use-device-preferences";

export type { DevicePreferencesControlRuntime };

interface SelectOption<T extends string> {
  readonly label: string;
  readonly value: T;
}

interface SelectPreferenceRowProps<T extends string> {
  readonly description: string;
  readonly errorMessage: string;
  readonly label: string;
  readonly onSave: (value: T) => Promise<void>;
  readonly options: readonly SelectOption<T>[];
  readonly value: T;
}

interface TogglePreferenceRowProps {
  readonly checked: boolean;
  readonly description: string;
  readonly errorMessage: string;
  readonly label: string;
  readonly onSave: (value: boolean) => Promise<void>;
}

const SIDEBAR_WIDTH_OPTIONS = [
  { value: "narrow", label: "Narrow" },
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
] as const satisfies readonly SelectOption<DevicePreferences["sidebarWidth"]>[];

const MESSAGE_TEXT_SIZE_OPTIONS = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
] as const satisfies readonly SelectOption<DevicePreferences["messageTextSize"]>[];

const TIMESTAMP_FORMAT_OPTIONS = [
  { value: "system", label: "System setting" },
  { value: "12-hour", label: "12-hour" },
  { value: "24-hour", label: "24-hour" },
] as const satisfies readonly SelectOption<DevicePreferences["timestampFormat"]>[];

const MOTION_OPTIONS = [
  { value: "system", label: "Follow system" },
  { value: "reduced", label: "Reduced" },
] as const satisfies readonly SelectOption<DevicePreferences["motionPreference"]>[];

function usePreferenceSave<T>({
  errorMessage,
  onSave,
  value,
}: {
  readonly errorMessage: string;
  readonly onSave: (next: T) => Promise<void>;
  readonly value: T;
}) {
  const savingRef = useRef(false);
  const [pendingValue, setPendingValue] = useState<Readonly<{ value: T }> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setError(""), [value]);

  const save = async (next: T): Promise<void> => {
    // The ref is the synchronous re-entrancy guard; the pending value doubles as the saving flag.
    if (savingRef.current || Object.is(next, value)) return;
    savingRef.current = true;
    setPendingValue({ value: next });
    setError("");
    try {
      await onSave(next);
    } catch {
      setError(errorMessage);
    } finally {
      savingRef.current = false;
      setPendingValue(null);
    }
  };

  return { error, save, saving: pendingValue !== null, value: pendingValue?.value ?? value };
}

interface PreferenceControlProps<T> {
  readonly describedBy: string;
  readonly disabled: boolean;
  readonly id: string;
  readonly invalid: true | undefined;
  readonly save: (next: T) => void;
  readonly value: T;
}

/** Owns the label, description, busy state, and error wiring shared by every preference control. */
function PreferenceRow<T>({
  children,
  className,
  description,
  errorMessage,
  label,
  onSave,
  value,
}: {
  readonly children: (control: PreferenceControlProps<T>) => ReactNode;
  readonly className?: string;
  readonly description: string;
  readonly errorMessage: string;
  readonly label: string;
  readonly onSave: (next: T) => Promise<void>;
  readonly value: T;
}) {
  const inputId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const {
    error,
    save,
    saving,
    value: displayedValue,
  } = usePreferenceSave({ errorMessage, onSave, value });

  return (
    <div
      className={`device-preference-row${className === undefined ? "" : ` ${className}`}`}
      aria-busy={saving}
    >
      <div className="device-preference-copy">
        <label htmlFor={inputId}>
          <strong>{label}</strong>
        </label>
        <small id={descriptionId}>{description}</small>
      </div>
      {children({
        describedBy: `${descriptionId}${error === "" ? "" : ` ${errorId}`}`,
        disabled: saving,
        id: inputId,
        invalid: error === "" ? undefined : true,
        save: (next) => void save(next),
        value: displayedValue,
      })}
      {error !== "" && (
        <span id={errorId} className="device-preference-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function SelectPreferenceRow<T extends string>({
  description,
  errorMessage,
  label,
  onSave,
  options,
  value,
}: SelectPreferenceRowProps<T>) {
  return (
    <PreferenceRow
      description={description}
      errorMessage={errorMessage}
      label={label}
      onSave={onSave}
      value={value}
    >
      {(control) => (
        <select
          id={control.id}
          value={control.value}
          disabled={control.disabled}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid}
          onChange={(event) => {
            const option = options.find(
              (candidate) => candidate.value === event.currentTarget.value,
            );
            if (option !== undefined) control.save(option.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </PreferenceRow>
  );
}

function TogglePreferenceRow({
  checked,
  description,
  errorMessage,
  label,
  onSave,
}: TogglePreferenceRowProps) {
  return (
    <PreferenceRow
      className="device-preference-toggle"
      description={description}
      errorMessage={errorMessage}
      label={label}
      onSave={onSave}
      value={checked}
    >
      {(control) => (
        <input
          id={control.id}
          type="checkbox"
          checked={control.value}
          disabled={control.disabled}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid}
          onChange={(event) => control.save(event.currentTarget.checked)}
        />
      )}
    </PreferenceRow>
  );
}

export function DeviceLayoutPreferences({
  runtime,
}: {
  readonly runtime: DevicePreferencesControlRuntime;
}) {
  const state = useDevicePreferences(runtime);

  return (
    <div className="device-preferences-list">
      <SelectPreferenceRow
        label="Sidebar width"
        description="Changes the width of the conversation list and workspace controls."
        value={state.sidebarWidth}
        options={SIDEBAR_WIDTH_OPTIONS}
        errorMessage="Could not save the sidebar width preference."
        onSave={async (sidebarWidth) => {
          await runtime.update({ sidebarWidth });
        }}
      />
    </div>
  );
}

export function DeviceMessagePreferences({
  runtime,
}: {
  readonly runtime: DevicePreferencesControlRuntime;
}) {
  const state = useDevicePreferences(runtime);

  return (
    <div className="device-preferences-list">
      <SelectPreferenceRow
        label="Message text size"
        description="Changes message and composer text in channels, direct messages, and threads."
        value={state.messageTextSize}
        options={MESSAGE_TEXT_SIZE_OPTIONS}
        errorMessage="Could not save the message text size preference."
        onSave={async (messageTextSize) => {
          await runtime.update({ messageTextSize });
        }}
      />
      <SelectPreferenceRow
        label="Time format"
        description="Choose how message times are shown."
        value={state.timestampFormat}
        options={TIMESTAMP_FORMAT_OPTIONS}
        errorMessage="Could not save the time format preference."
        onSave={async (timestampFormat) => {
          await runtime.update({ timestampFormat });
        }}
      />
      <TogglePreferenceRow
        label="Group consecutive messages"
        description="Combine adjacent messages from the same person under one name and avatar."
        checked={state.groupConsecutiveMessages}
        errorMessage="Could not save the message grouping preference."
        onSave={async (groupConsecutiveMessages) => {
          await runtime.update({ groupConsecutiveMessages });
        }}
      />
      <TogglePreferenceRow
        label="Always show grouped message times"
        description="Keep each grouped message time visible instead of showing it on hover."
        checked={state.alwaysShowGroupedMessageTimes}
        errorMessage="Could not save the grouped message time preference."
        onSave={async (alwaysShowGroupedMessageTimes) => {
          await runtime.update({ alwaysShowGroupedMessageTimes });
        }}
      />
      <TogglePreferenceRow
        label="Show profile titles"
        description="Show a person's profile title beside their name in message headers."
        checked={state.showProfileTitles}
        errorMessage="Could not save the profile title preference."
        onSave={async (showProfileTitles) => {
          await runtime.update({ showProfileTitles });
        }}
      />
    </div>
  );
}

export function DeviceComposerPreferences({
  platform,
  runtime,
}: {
  readonly platform: DesktopPlatform;
  readonly runtime: DevicePreferencesControlRuntime;
}) {
  const state = useDevicePreferences(runtime);
  const shortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter", label: platform === "darwin" ? "Command + Enter" : "Ctrl + Enter" },
  ] as const satisfies readonly SelectOption<DevicePreferences["sendMessageShortcut"]>[];

  return (
    <div className="device-preferences-list">
      <SelectPreferenceRow
        label="Send messages with"
        description="Choose whether Enter sends a message or starts a new line."
        value={state.sendMessageShortcut}
        options={shortcutOptions}
        errorMessage="Could not save the send shortcut preference."
        onSave={async (sendMessageShortcut) => {
          await runtime.update({ sendMessageShortcut });
        }}
      />
      <TogglePreferenceRow
        label="Check spelling"
        description="Show spelling suggestions while you write messages."
        checked={state.spellCheck}
        errorMessage="Could not save the spell check preference."
        onSave={async (spellCheck) => {
          await runtime.update({ spellCheck });
        }}
      />
    </div>
  );
}

export function DeviceAccessibilityPreferences({
  runtime,
}: {
  readonly runtime: DevicePreferencesControlRuntime;
}) {
  const state = useDevicePreferences(runtime);

  return (
    <div className="device-preferences-list">
      <SelectPreferenceRow
        label="Motion"
        description="Follow the system setting or stop interface animations and transitions."
        value={state.motionPreference}
        options={MOTION_OPTIONS}
        errorMessage="Could not save the motion preference."
        onSave={async (motionPreference) => {
          await runtime.update({ motionPreference });
        }}
      />
    </div>
  );
}
