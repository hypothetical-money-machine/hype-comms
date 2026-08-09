import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { ThemeRuntime } from "./theme-runtime";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Renderer root element was not found");
}

const theme = new ThemeRuntime(window.hmmChat, document.documentElement);
const compactMode = new CompactModeRuntime(window.hmmChat, document.documentElement);

void theme.start();
void compactMode.start();
createRoot(rootElement).render(
  <StrictMode>
    <App client={window.hmmChat} theme={theme} compactMode={compactMode} />
  </StrictMode>,
);

window.addEventListener(
  "beforeunload",
  () => {
    theme.dispose();
    compactMode.dispose();
  },
  { once: true },
);
