// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useOpenChangeNotifier } from "./use-open-change-notifier";

describe("useOpenChangeNotifier", () => {
  it("reports an opening when the host mounts already open", () => {
    const onOpenChange = vi.fn();
    const { unmount } = renderHook(() => useOpenChangeNotifier(true, onOpenChange));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);

    unmount();
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("does not report a closed mount, then reports later open and close", () => {
    const onOpenChange = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) => useOpenChangeNotifier(open, onOpenChange),
      { initialProps: { open: false } },
    );

    expect(onOpenChange).not.toHaveBeenCalled();
    rerender({ open: true });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);

    unmount();
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});
