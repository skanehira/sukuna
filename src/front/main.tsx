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
import { createRecapApi } from "./lib/recap/api";
import { createConversationApi } from "./lib/conversation/api";
import { createLifecycleApi } from "./lib/lifecycle/api";
import { createConversationWorkspace } from "./lib/conversation/workspace";
import type { RealtimeSocket } from "./lib/realtime";
import { ulid } from "ulid";

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
const conversations = createConversationWorkspace(
  createConversationApi(window.fetch.bind(window)),
  controller,
  {
    clientId: ulid(),
    id: ulid,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  },
  () =>
    new WebSocket(
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`,
    ) as unknown as RealtimeSocket,
  {
    recap: { api: createRecapApi(window.fetch.bind(window)), storage: window.sessionStorage },
    lifecycle: {
      api: createLifecycleApi(window.fetch.bind(window)),
      openExternal: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  },
);
const stopConversations = conversations.start();
const pagehide = () => conversations.pagehide();
window.addEventListener("pagehide", pagehide);
const visibility = () => conversations.visibility(document.visibilityState === "visible");
document.addEventListener("visibilitychange", visibility);
visibility();
const dismissNotice = (event: KeyboardEvent) => {
  if (event.key === "Escape") notices.dismissError();
};
window.addEventListener("keydown", dismissNotice);
import.meta.hot?.dispose(() => {
  window.removeEventListener("keydown", dismissNotice);
  notices.dispose();
  window.removeEventListener("pagehide", pagehide);
  stopConversations();
  document.removeEventListener("visibilitychange", visibility);
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
            loadScreen={conversations.loadScreen}
            renderRight={conversations.renderRight}
            connection={conversations.connection}
          />
        )}
      </AuthenticationGuard>
    </ShellBoundary>
  </StrictMode>,
);
