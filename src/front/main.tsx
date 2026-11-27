import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { createBrowserController } from "./lib/browser";
import { parseRoute } from "./lib/routes";
import { AuthenticationGuard, createIdentityLoader } from "./shell/AuthenticationGuard";
import { createNavigation } from "./shell/navigation";
import { createNotices } from "./shell/notices";
import { ShellBoundary } from "./shell/ShellBoundary";

const reload = () => window.location.reload();
const navigation = createNavigation(
  parseRoute(`${window.location.pathname}${window.location.search}`),
  reload,
  (url) => controller.navigate(url),
);
const { controller, dispose } = createBrowserController(window, navigation.open);
const notices = createNotices({
  schedule: (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    return () => window.clearTimeout(id);
  },
});
controller.options.notify = notices.notify;
const dismissNotice = (event: KeyboardEvent) => {
  if (event.key === "Escape") notices.dismissError();
};
window.addEventListener("keydown", dismissNotice);
import.meta.hot?.dispose(() => {
  window.removeEventListener("keydown", dismissNotice);
  notices.dispose();
  dispose();
});
const loadIdentity = createIdentityLoader((url) => window.fetch(url));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellBoundary onReload={reload}>
      <AuthenticationGuard load={loadIdentity} onReload={reload}>
        {(identityRecovery) => (
          <App
            controller={controller}
            navigation={navigation}
            notices={notices}
            identityRecovery={identityRecovery}
          />
        )}
      </AuthenticationGuard>
    </ShellBoundary>
  </StrictMode>,
);
