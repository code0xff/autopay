import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/ui/theme.css";
import { applyTheme } from "../../src/ui/rpc-client.js";
import { App } from "./App.js";

applyTheme();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
