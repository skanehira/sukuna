import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { createBrowserController } from "./lib/browser";

const { controller } = createBrowserController(window, () => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);
