import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { restoreMemberListHeight } from "./member-list-height";
import { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeRuntime } from "./theme-runtime";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Renderer root element was not found");
}

const theme = new ThemeRuntime(window.hypeComms, document.documentElement);
const compactMode = new CompactModeRuntime(window.hypeComms, document.documentElement);
const sidebarPosition = new SidebarPositionRuntime(document.documentElement);
restoreMemberListHeight(document.documentElement);

void theme.start();
void compactMode.start();
createRoot(rootElement).render(
  <StrictMode>
    <App
      client={window.hypeComms}
      theme={theme}
      compactMode={compactMode}
      sidebarPosition={sidebarPosition}
    />
  </StrictMode>,
);

window.addEventListener(
  "beforeunload",
  () => {
    theme.dispose();
    compactMode.dispose();
    sidebarPosition.dispose();
  },
  { once: true },
);
