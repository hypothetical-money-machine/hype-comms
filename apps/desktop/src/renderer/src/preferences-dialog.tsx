import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { User } from "@hype-comms/contracts";

import type { DesktopPlatform, NotificationTransport } from "../../shared/desktop-api";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { CompactModeToggle } from "./compact-mode-toggle";
import { FencedBlockquoteControl } from "./fenced-blockquote-control";
import type { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { NotificationSettings } from "./notification-settings";
import { ProfileSection } from "./profile-section";
import { SidebarPositionControl } from "./sidebar-position-control";
import type { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeDesigner } from "./theme-designer";
import { ThemeSelector } from "./theme-selector";
import type { ThemeRuntime } from "./theme-runtime";
import { useOpenChangeNotifier } from "./use-open-change-notifier";

interface PreferencesDialogProps {
  readonly open: boolean;
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly fencedBlockquotes: FencedBlockquoteRuntime;
  readonly sidebarPosition: SidebarPositionRuntime;
  readonly notifications?: NotificationTransport;
  readonly platform: DesktopPlatform;
  readonly currentUser: User;
  readonly onUpdateProfile: (title: string | null) => Promise<void>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="radio"]):not([tabindex="-1"])',
  'input[type="radio"]:checked:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function PreferencesDialog({
  open,
  theme,
  compactMode,
  fencedBlockquotes,
  sidebarPosition,
  notifications,
  platform,
  currentUser,
  onUpdateProfile,
  triggerRef,
  onClose,
  onOpenChange,
}: PreferencesDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const discardDialogRef = useRef<HTMLElement>(null);
  const discardKeepEditingRef = useRef<HTMLButtonElement>(null);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const designerTriggerRef = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(false);
  const previousView = useRef<"preferences" | "designer">("preferences");
  const [view, setView] = useState<"preferences" | "designer">("preferences");
  const [designerDirty, setDesignerDirty] = useState(false);
  const [designerSaving, setDesignerSaving] = useState(false);
  const [discardAction, setDiscardAction] = useState<"preferences" | "close" | null>(null);

  useOpenChangeNotifier(open, onOpenChange);

  const returnToPreferences = useCallback((): void => {
    if (designerSaving) return;
    if (designerDirty) {
      discardReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscardAction("preferences");
      return;
    }
    setView("preferences");
  }, [designerDirty, designerSaving]);

  const requestClose = useCallback((): void => {
    if (designerSaving) return;
    if (view === "designer" && designerDirty) {
      discardReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscardAction("close");
      return;
    }
    onClose();
  }, [designerDirty, designerSaving, onClose, view]);

  const finishDesigner = useCallback((): void => {
    setDesignerDirty(false);
    setDesignerSaving(false);
    setDiscardAction(null);
    setView("preferences");
  }, []);

  useEffect(() => {
    if (!open) {
      setView("preferences");
      setDesignerDirty(false);
      setDesignerSaving(false);
      setDiscardAction(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (discardAction !== null) {
        setDiscardAction(null);
        queueMicrotask(() => discardReturnFocusRef.current?.focus());
        return;
      }
      if (view === "designer") {
        returnToPreferences();
      } else {
        requestClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [discardAction, open, requestClose, returnToPreferences, view]);

  useLayoutEffect(() => {
    if (!open) {
      if (previousOpen.current) triggerRef.current?.focus();
      previousOpen.current = false;
      previousView.current = "preferences";
      return;
    }

    previousOpen.current = true;
    if (discardAction !== null) {
      discardKeepEditingRef.current?.focus();
      return;
    }
    const returningFromDesigner = previousView.current === "designer" && view === "preferences";
    previousView.current = view;
    if (returningFromDesigner) {
      designerTriggerRef.current?.focus();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
    if (firstFocusable === null) dialog.focus();
  }, [discardAction, open, triggerRef, view]);

  if (!open) return null;

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const dialog = discardAction === null ? dialogRef.current : discardDialogRef.current;
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
    <div className="dialog-backdrop" onMouseDown={requestClose}>
      <section
        ref={dialogRef}
        className={`preferences-dialog${view === "designer" ? " theme-designer-dialog" : ""}`}
        id="preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        aria-hidden={discardAction !== null ? true : undefined}
        inert={discardAction !== null ? true : undefined}
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          {view === "designer" && (
            <button
              type="button"
              disabled={designerSaving}
              className="preferences-back"
              aria-label="Back to preferences"
              onClick={returnToPreferences}
            >
              ←
            </button>
          )}
          <div>
            <p className="eyebrow">
              {view === "designer" ? "Workspace appearance" : "Workspace preferences"}
            </p>
            <h2 id="preferences-title">{view === "designer" ? "Theme designer" : "Preferences"}</h2>
          </div>
          <button
            type="button"
            disabled={designerSaving}
            aria-label="Close preferences"
            onClick={requestClose}
          >
            ×
          </button>
        </header>

        {view === "designer" ? (
          <ThemeDesigner
            theme={theme}
            onCancel={returnToPreferences}
            onDirtyChange={setDesignerDirty}
            onSavingChange={setDesignerSaving}
            onSaved={finishDesigner}
          />
        ) : (
          <>
            <section aria-labelledby="preferences-profile-title">
              <h3 id="preferences-profile-title">Profile</h3>
              <ProfileSection currentUser={currentUser} onUpdateProfile={onUpdateProfile} />
            </section>
            <section aria-labelledby="preferences-appearance-title">
              <h3 id="preferences-appearance-title">Appearance</h3>
              <ThemeSelector
                theme={theme}
                designButtonRef={designerTriggerRef}
                onDesign={() => setView("designer")}
              />
            </section>
            <section aria-labelledby="preferences-layout-title">
              <h3 id="preferences-layout-title">Layout</h3>
              <SidebarPositionControl sidebarPosition={sidebarPosition} />
              <CompactModeToggle compactMode={compactMode} platform={platform} />
            </section>
            <section aria-labelledby="preferences-messages-title">
              <h3 id="preferences-messages-title">Messages</h3>
              <FencedBlockquoteControl runtime={fencedBlockquotes} />
            </section>
            <section aria-labelledby="preferences-notifications-title">
              <h3 id="preferences-notifications-title">Notifications</h3>
              <NotificationSettings transport={notifications} />
            </section>
          </>
        )}
      </section>
      {discardAction !== null && (
        <div className="theme-discard-overlay" onMouseDown={(event) => event.stopPropagation()}>
          <section
            ref={discardDialogRef}
            className="theme-discard-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="theme-discard-title"
            aria-describedby="theme-discard-description"
            onKeyDown={trapFocus}
          >
            <p className="eyebrow">Unsaved theme</p>
            <h3 id="theme-discard-title">Discard your changes?</h3>
            <p id="theme-discard-description">
              Your current app theme is still safe. Only this unsaved draft will be lost.
            </p>
            <div>
              <button
                ref={discardKeepEditingRef}
                type="button"
                onClick={() => {
                  setDiscardAction(null);
                  queueMicrotask(() => discardReturnFocusRef.current?.focus());
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const action = discardAction;
                  setDesignerDirty(false);
                  setDiscardAction(null);
                  if (action === "close") onClose();
                  else setView("preferences");
                }}
              >
                Discard changes
              </button>
            </div>
          </section>
        </div>
      )}
    </div>,
    document.body,
  );
}
