import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  type FencedBlockquoteMode,
  type FencedBlockquoteRuntime,
} from "./fenced-blockquote-runtime";

const FencedBlockquoteModeContext = createContext<FencedBlockquoteMode>("off");

export function FencedBlockquoteProvider({
  children,
  runtime,
}: {
  readonly children: ReactNode;
  readonly runtime: FencedBlockquoteRuntime;
}) {
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.mode, [runtime]);
  const mode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <FencedBlockquoteModeContext.Provider value={mode}>
      {children}
    </FencedBlockquoteModeContext.Provider>
  );
}

export function useFencedBlockquoteMode(): FencedBlockquoteMode {
  return useContext(FencedBlockquoteModeContext);
}
