import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { DesktopPlatform, NotificationTransport } from "../../shared/desktop-api";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { CompactModeToggle } from "./compact-mode-toggle";
import { NotificationSettings } from "./notification-settings";
import { ThemeSelector } from "./theme-selector";
import type { ThemeRuntime } from "./theme-runtime";
import { useOpenChangeNotifier } from "./use-open-change-notifier";

interface PreferencesDialogProps {
  readonly open: boolean;
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly notifications?: NotificationTransport;
  readonly platform: DesktopPlatform;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function PreferencesDialog({
  open,
  theme,
  compactMode,
  notifications,
  platform,
  triggerRef,
  onClose,
  onOpenChange,
}: PreferencesDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousOpen = useRef(false);

  useOpenChangeNotifier(open, onOpenChange);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useLayoutEffect(() => {
    if (!open) {
      if (previousOpen.current) triggerRef.current?.focus();
      previousOpen.current = false;
      return;
    }

    previousOpen.current = true;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    if (firstFocusable === null) dialog.focus();
  }, [open, triggerRef]);

  if (!open) return null;

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="preferences-dialog"
        id="preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Workspace preferences</p>
            <h2 id="preferences-title">Preferences</h2>
          </div>
          <button type="button" aria-label="Close preferences" onClick={onClose}>
            ×
          </button>
        </header>

        <section aria-labelledby="preferences-appearance-title">
          <h3 id="preferences-appearance-title">Appearance</h3>
          <ThemeSelector theme={theme} />
        </section>
        <section aria-labelledby="preferences-layout-title">
          <h3 id="preferences-layout-title">Layout</h3>
          <CompactModeToggle compactMode={compactMode} platform={platform} />
        </section>
        <section aria-labelledby="preferences-notifications-title">
          <h3 id="preferences-notifications-title">Notifications</h3>
          <NotificationSettings transport={notifications} />
        </section>
      </section>
    </div>,
    document.body,
  );
}
