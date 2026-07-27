import { channelSlugFromName, type ChannelAccess } from "@hmm-chat/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";

interface ChannelCreatePopoverProps {
  readonly onCreate: (name: string, slug: string, access: ChannelAccess) => Promise<void>;
}

interface PopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly arrowLeft: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not create the channel";
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 10;
const POPOVER_WIDTH = 320;
const ARROW_MARGIN = 18;

export function ChannelCreatePopover({ onCreate }: ChannelCreatePopoverProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ChannelAccess>("workspace");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const restoreFocus = useRef(false);
  const slug = channelSlugFromName(name);

  const dismiss = useCallback(() => {
    if (creatingRef.current) return;
    setOpen(false);
    setName("");
    setAccess("workspace");
    setError("");
    setPosition(null);
    restoreFocus.current = true;
  }, []);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  const updatePosition = useCallback(() => {
    const anchor = trigger.current;
    const dialog = popover.current;
    if (anchor === null || dialog === null) return;
    const anchorRect = anchor.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_MARGIN * 2));
    const maximumLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(anchorRect.right - width, VIEWPORT_MARGIN), maximumLeft);
    const below = anchorRect.bottom + ANCHOR_GAP;
    const above = anchorRect.top - dialogRect.height - ANCHOR_GAP;
    const preferredTop =
      below + dialogRect.height <= window.innerHeight - VIEWPORT_MARGIN || above < VIEWPORT_MARGIN
        ? below
        : above;
    const maximumTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - dialogRect.height - VIEWPORT_MARGIN,
    );
    const top = Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maximumTop);
    const arrowLeft = Math.min(
      Math.max(anchorRect.left + anchorRect.width / 2 - left, ARROW_MARGIN),
      width - ARROW_MARGIN,
    );
    setPosition({ left, top, width, arrowLeft });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    input.current?.focus();
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        popover.current?.contains(target) === true ||
        trigger.current?.contains(target) === true
      ) {
        return;
      }
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [dismiss, open, updatePosition]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const displayName = name.trim();
    if (displayName === "" || slug === "") {
      setError("Use at least one Unicode letter or number in the channel name.");
      input.current?.focus();
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    setError("");
    try {
      await onCreate(displayName, slug, access);
      creatingRef.current = false;
      setCreating(false);
      dismiss();
    } catch (submitError) {
      setError(errorMessage(submitError));
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const style = {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    width: position?.width ?? POPOVER_WIDTH,
    visibility: position === null ? "hidden" : "visible",
    "--channel-create-arrow-left": `${String(position?.arrowLeft ?? ARROW_MARGIN)}px`,
  } as CSSProperties;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Create channel"
        aria-controls="channel-create-popover"
        aria-expanded={open}
        disabled={creating}
        onClick={() => {
          if (open) dismiss();
          else setOpen(true);
        }}
      >
        +
      </button>
      {open &&
        createPortal(
          <form
            className="channel-create-popover"
            id="channel-create-popover"
            ref={popover}
            role="dialog"
            aria-labelledby="channel-create-title"
            aria-busy={creating}
            style={style}
            onSubmit={(event) => void submit(event)}
          >
            <header>
              <div>
                <h2 id="channel-create-title">Create a channel</h2>
                <p>Choose who can find and read this channel.</p>
              </div>
              <button
                className="channel-create-close"
                type="button"
                aria-label="Close channel creation"
                disabled={creating}
                onClick={dismiss}
              >
                ×
              </button>
            </header>

            <label htmlFor="channel-name">Channel name</label>
            <input
              id="channel-name"
              ref={input}
              value={name}
              maxLength={100}
              autoComplete="off"
              placeholder="e.g. Launch Planning"
              aria-invalid={error === "" ? undefined : true}
              aria-describedby="channel-create-details"
              disabled={creating}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
            <div className="channel-create-details" id="channel-create-details">
              <span>{name.length} / 100</span>
              <code className={slug === "" ? "empty" : ""}>#{slug || "channel-name"}</code>
            </div>
            {name.trim() !== "" && slug === "" && (
              <p className="channel-create-guidance">
                Add a Unicode letter or number; symbols and emoji alone cannot form a channel.
              </p>
            )}

            <fieldset className="channel-access-options">
              <legend>Who has access?</legend>
              <label>
                <input
                  type="radio"
                  name="channel-access"
                  value="workspace"
                  checked={access === "workspace"}
                  disabled={creating}
                  onChange={() => setAccess("workspace")}
                />
                <span>
                  <strong>Everyone</strong>
                  <small>All workspace members can read and send.</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="channel-access"
                  value="members"
                  checked={access === "members"}
                  disabled={creating}
                  onChange={() => setAccess("members")}
                />
                <span>
                  <strong>Invited members</strong>
                  <small>Only people added by a channel owner.</small>
                </span>
              </label>
            </fieldset>

            <p className="channel-create-error" role="alert">
              {error}
            </p>
            <footer>
              <button type="button" disabled={creating} onClick={dismiss}>
                Cancel
              </button>
              <button type="submit" disabled={creating || name.trim() === "" || slug === ""}>
                {creating ? "Creating…" : "Create"}
              </button>
            </footer>
          </form>,
          document.body,
        )}
    </>
  );
}
