import { useEffect, useRef } from "react";

/**
 * Reports open/closed transitions to an optional listener, including a closed report when the
 * component unmounts while open — without that, a compact-mode chrome pin would leak and the
 * overlay could never auto-hide again. Any popover anchored in the workspace rail or sidebar
 * should call this with its open state.
 */
export function useOpenChangeNotifier(
  open: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): void {
  const previousOpen = useRef(open);
  useEffect(() => {
    if (previousOpen.current !== open) {
      previousOpen.current = open;
      onOpenChange?.(open);
    }
    return () => {
      if (previousOpen.current) {
        previousOpen.current = false;
        onOpenChange?.(false);
      }
    };
  }, [open, onOpenChange]);
}
