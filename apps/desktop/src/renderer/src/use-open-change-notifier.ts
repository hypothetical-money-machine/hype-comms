import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Reports open/closed transitions to an optional listener, including an open report when the
 * component mounts already open and a closed report when it unmounts while open — without those,
 * a compact-mode chrome pin would never be acquired (or would leak) and the overlay could hide
 * behind a modal or never auto-hide again. Any popover anchored in the workspace rail or sidebar
 * should call this with its open state.
 */
export function useOpenChangeNotifier(
  open: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): void {
  const latest = useRef(onOpenChange);
  useLayoutEffect(() => {
    latest.current = onOpenChange;
  });
  useEffect(() => {
    if (!open) return;
    // Close the same owner's pin that was opened, even if the next render changes the callback.
    const listener = latest.current;
    listener?.(true);
    return () => listener?.(false);
  }, [open]);
}
