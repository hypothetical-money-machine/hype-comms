import { useCallback, useId, useSyncExternalStore } from "react";

import {
  type FencedBlockquoteMode,
  type FencedBlockquoteRuntime,
} from "./fenced-blockquote-runtime";

const OPTIONS: readonly { readonly label: string; readonly value: FencedBlockquoteMode }[] = [
  { value: "off", label: "Off" },
  { value: "double-quote", label: '"""' },
  { value: "greater-than", label: ">>>" },
];

export function FencedBlockquoteControl({
  runtime,
}: {
  readonly runtime: FencedBlockquoteRuntime;
}) {
  const groupName = useId();
  const labelId = useId();
  const descriptionId = useId();
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.mode, [runtime]);
  const mode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <div
      className="fenced-blockquote-control"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
    >
      <span id={labelId}>Fenced blockquotes</span>
      <div className="fenced-blockquote-options">
        {OPTIONS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={mode === option.value}
              onChange={() => runtime.setMode(option.value)}
            />
            <code>{option.label}</code>
          </label>
        ))}
      </div>
      <p id={descriptionId}>Interpret matching lines as a multiline quote fence.</p>
    </div>
  );
}
