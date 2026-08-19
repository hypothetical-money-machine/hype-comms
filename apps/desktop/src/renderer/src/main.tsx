import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { FencedBlockquoteProvider } from "./fenced-blockquote-context";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeRuntime } from "./theme-runtime";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Renderer root element was not found");
}

const theme = new ThemeRuntime(window.hypeComms, document.documentElement);
const compactMode = new CompactModeRuntime(window.hypeComms, document.documentElement);
const fencedBlockquotes = new FencedBlockquoteRuntime();
const sidebarPosition = new SidebarPositionRuntime(document.documentElement);

void theme.start();
void compactMode.start();
createRoot(rootElement).render(
  <StrictMode>
    <FencedBlockquoteProvider runtime={fencedBlockquotes}>
      <App
        client={window.hypeComms}
        theme={theme}
        compactMode={compactMode}
        fencedBlockquotes={fencedBlockquotes}
        sidebarPosition={sidebarPosition}
      />
    </FencedBlockquoteProvider>
  </StrictMode>,
);

window.addEventListener(
  "beforeunload",
  () => {
    theme.dispose();
    compactMode.dispose();
    fencedBlockquotes.dispose();
    sidebarPosition.dispose();
  },
  { once: true },
);
