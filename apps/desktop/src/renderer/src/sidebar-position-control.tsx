import { useCallback, useId, useSyncExternalStore } from "react";

import type { SidebarPosition, SidebarPositionRuntime } from "./sidebar-position-runtime";

interface SidebarPositionControlProps {
  readonly sidebarPosition: SidebarPositionRuntime;
}

export function SidebarPositionControl({ sidebarPosition }: SidebarPositionControlProps) {
  const groupName = useId();
  const labelId = useId();
  const subscribe = useCallback(
    (listener: () => void) => sidebarPosition.subscribe(listener),
    [sidebarPosition],
  );
  const getSnapshot = useCallback(() => sidebarPosition.position, [sidebarPosition]);
  const position = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const option = (value: SidebarPosition, label: string) => (
    <label>
      <input
        type="radio"
        name={groupName}
        value={value}
        checked={position === value}
        onChange={() => sidebarPosition.setPosition(value)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="sidebar-position-control" role="group" aria-labelledby={labelId}>
      <span id={labelId}>Sidebar position</span>
      <div className="sidebar-position-options">
        {option("left", "Left")}
        {option("right", "Right")}
      </div>
    </div>
  );
}
