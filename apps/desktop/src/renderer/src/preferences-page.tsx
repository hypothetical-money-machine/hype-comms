import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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

interface PreferencesPageProps {
  readonly active: boolean;
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly fencedBlockquotes: FencedBlockquoteRuntime;
  readonly sidebarPosition: SidebarPositionRuntime;
  readonly notifications?: NotificationTransport;
  readonly platform: DesktopPlatform;
  readonly currentUser: User;
  readonly onUpdateProfile: (title: string | null) => Promise<void>;
}

export interface PreferencesPageHandle {
  requestNavigationAway: () => Promise<boolean>;
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

export const PreferencesPage = forwardRef<PreferencesPageHandle, PreferencesPageProps>(
  function PreferencesPage(
    {
      active,
      theme,
      compactMode,
      fencedBlockquotes,
      sidebarPosition,
      notifications,
      platform,
      currentUser,
      onUpdateProfile,
    },
    ref,
  ) {
    const discardDialogRef = useRef<HTMLElement>(null);
    const discardOverlayRef = useRef<HTMLDivElement>(null);
    const discardKeepEditingRef = useRef<HTMLButtonElement>(null);
    const discardReturnFocusRef = useRef<HTMLElement | null>(null);
    const designerTriggerRef = useRef<HTMLButtonElement>(null);
    const previousView = useRef<"preferences" | "designer">("preferences");
    const leaveResolver = useRef<((confirmed: boolean) => void) | null>(null);
    const [view, setView] = useState<"preferences" | "designer">("preferences");
    const [designerDirty, setDesignerDirty] = useState(false);
    const [designerSaving, setDesignerSaving] = useState(false);
    const [discardAction, setDiscardAction] = useState<"preferences" | "leave" | null>(null);

    const resolvePendingLeave = useCallback((confirmed: boolean): void => {
      const resolve = leaveResolver.current;
      leaveResolver.current = null;
      resolve?.(confirmed);
    }, []);

    const cancelDiscard = useCallback((): void => {
      const action = discardAction;
      setDiscardAction(null);
      if (action === "leave") resolvePendingLeave(false);
      queueMicrotask(() => discardReturnFocusRef.current?.focus());
    }, [discardAction, resolvePendingLeave]);

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

    const finishDesigner = useCallback((): void => {
      setDesignerDirty(false);
      setDesignerSaving(false);
      setDiscardAction(null);
      setView("preferences");
    }, []);

    const requestNavigationAway = useCallback((): Promise<boolean> => {
      if (designerSaving || discardAction !== null) return Promise.resolve(false);
      if (view !== "designer") return Promise.resolve(true);
      if (!designerDirty) {
        setView("preferences");
        return Promise.resolve(true);
      }

      discardReturnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return new Promise<boolean>((resolve) => {
        leaveResolver.current = resolve;
        setDiscardAction("leave");
      });
    }, [designerDirty, designerSaving, discardAction, view]);

    useImperativeHandle(ref, () => ({ requestNavigationAway }), [requestNavigationAway]);

    useEffect(
      () => () => {
        resolvePendingLeave(false);
      },
      [resolvePendingLeave],
    );

    useEffect(() => {
      if (active || discardAction === null) return;
      setDiscardAction(null);
      resolvePendingLeave(false);
    }, [active, discardAction, resolvePendingLeave]);

    useEffect(() => {
      if (!active || discardAction === null) return;
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelDiscard();
      };
      document.addEventListener("keydown", onKeyDown, true);
      return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [active, cancelDiscard, discardAction]);

    useEffect(() => {
      if (!active || discardAction === null) return;
      const overlay = discardOverlayRef.current;
      if (overlay === null) return;
      const stopPointerPropagation = (event: PointerEvent): void => event.stopPropagation();
      overlay.addEventListener("pointerdown", stopPointerPropagation);
      return () => overlay.removeEventListener("pointerdown", stopPointerPropagation);
    }, [active, discardAction]);

    useLayoutEffect(() => {
      if (!active) {
        previousView.current = view;
        return;
      }
      if (discardAction !== null) {
        discardKeepEditingRef.current?.focus();
        return;
      }
      const returningFromDesigner = previousView.current === "designer" && view === "preferences";
      previousView.current = view;
      if (returningFromDesigner) designerTriggerRef.current?.focus();
    }, [active, discardAction, view]);

    const trapDiscardFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (event.key !== "Tab") return;
      const dialog = discardDialogRef.current;
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

    return (
      <>
        <section
          className={`preferences-page${view === "designer" ? " theme-designer-page" : ""}`}
          aria-labelledby="preferences-title"
          aria-hidden={discardAction !== null ? true : undefined}
          data-testid="preferences-page"
          hidden={!active}
          inert={discardAction !== null ? true : undefined}
        >
          <header className="preferences-page-header">
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
              <h2 id="preferences-title">
                {view === "designer" ? "Theme designer" : "Preferences"}
              </h2>
            </div>
          </header>

          {active &&
            (view === "designer" ? (
              <ThemeDesigner
                theme={theme}
                onCancel={returnToPreferences}
                onDirtyChange={setDesignerDirty}
                onSavingChange={setDesignerSaving}
                onSaved={finishDesigner}
              />
            ) : (
              <div className="preferences-page-body">
                <div className="preferences-page-content">
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
                </div>
              </div>
            ))}
        </section>
        {discardAction !== null &&
          createPortal(
            <div ref={discardOverlayRef} className="theme-discard-overlay">
              <section
                ref={discardDialogRef}
                className="theme-discard-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="theme-discard-title"
                aria-describedby="theme-discard-description"
                onKeyDown={trapDiscardFocus}
              >
                <p className="eyebrow">Unsaved theme</p>
                <h3 id="theme-discard-title">Discard your changes?</h3>
                <p id="theme-discard-description">
                  Your current app theme is still safe. Only this unsaved draft will be lost.
                </p>
                <div>
                  <button ref={discardKeepEditingRef} type="button" onClick={cancelDiscard}>
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const action = discardAction;
                      setDesignerDirty(false);
                      setDesignerSaving(false);
                      setDiscardAction(null);
                      setView("preferences");
                      if (action === "leave") resolvePendingLeave(true);
                    }}
                  >
                    Discard changes
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )}
      </>
    );
  },
);
