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
import { createSettingsApi, createSettingsStore } from "./lib/settings-store";
import { loadSettingsScreen, registerSettingsCommands } from "./lib/settings-workspace";
import { ulid } from "ulid";
import { createInboxApi, InboxStore } from "./lib/inbox-store";
import { InboxPage } from "./pages/inbox";
import { ProjectPage } from "./pages/project";
import { Tree, registerInboxNavigation } from "./components/tree";
import type { ScreenLoader } from "./App";

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
const reportSettingsError = (error: unknown) => {
  notices.notify(error instanceof Error ? error.message : "設定を読み込めませんでした。", "error");
};
const settings = createSettingsStore(
  createSettingsApi(window.fetch.bind(window)),
  reportSettingsError,
);
controller.options.keymap = settings.keymap;
const stopSettingsCommands = registerSettingsCommands(controller);
const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const formatTime = (at: number) => timeFormat.format(at);
const inboxApi = createInboxApi(window.fetch.bind(window));
const inbox = new InboxStore(inboxApi, {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    return () => window.clearTimeout(id);
  },
  storage: window.sessionStorage,
});
const stopInboxNavigation = registerInboxNavigation(controller, inbox);
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
    inbox,
    recap: { api: createRecapApi(window.fetch.bind(window)), storage: window.sessionStorage },
    lifecycle: {
      api: createLifecycleApi(window.fetch.bind(window)),
      openExternal: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    settingsChanged: () => {
      void settings.refresh().catch(reportSettingsError);
    },
  },
);
const loadScreen: ScreenLoader = async (route) => {
  if (route.kind === "home")
    return {
      kind: "ready",
      title: "一覧",
      fullWindow: true,
      content: <InboxPage store={inbox} controller={controller} />,
    };
  if (route.kind === "project" && route.id && !route.view)
    return {
      kind: "ready",
      title: "プロジェクト",
      fullWindow: true,
      content: (
        <ProjectPage
          key={route.id}
          store={inbox}
          id={route.id}
          controller={controller}
          withdraw={inboxApi.withdraw}
        />
      ),
    };
  return (
    loadSettingsScreen(route, controller, settings, formatTime) ?? conversations.loadScreen(route)
  );
};
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
  stopSettingsCommands();
  stopConversations();
  stopInboxNavigation();
  inbox.dispose();
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
            loadScreen={loadScreen}
            renderTree={(route) => <Tree store={inbox} route={route} />}
            renderRight={conversations.renderRight}
            connection={conversations.connection}
          />
        )}
      </AuthenticationGuard>
    </ShellBoundary>
  </StrictMode>,
);
