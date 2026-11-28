import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { createBrowserController } from "./lib/browser";
import { createBuildCheck } from "./lib/build-check";
import { parseRoute } from "./lib/routes";
import { AuthenticationGuard, createIdentityLoader } from "./shell/AuthenticationGuard";
import { createNavigation } from "./shell/navigation";
import { createNotices } from "./shell/notices";
import { ShellBoundary } from "./shell/ShellBoundary";
import { createRecapApi } from "./lib/recap/api";
import { createConversationApi } from "./lib/conversation/api";
import { createLifecycleApi } from "./lib/lifecycle/api";
import { createProgressApi } from "./lib/conversation/work-monitor";
import { createConversationWorkspace } from "./lib/conversation/workspace";
import { createStockApi } from "./lib/stock/api";
import { createFilesApi } from "./lib/files/api";
import type { RealtimeSocket } from "./lib/realtime";
import { createProjectSettingsApi } from "./lib/project-settings-api";
import { createSettingsApi, createSettingsStore } from "./lib/settings-store";
import { loadSettingsScreen, registerSettingsCommands } from "./lib/settings-workspace";
import { createProjectUsageApi } from "./lib/project-usage-api";
import { loadProjectUsageScreen, registerUsageCommand } from "./lib/project-usage-workspace";
import { ulid } from "ulid";
import { createInboxApi, InboxStore } from "./lib/inbox-store";
import { InboxPage } from "./pages/inbox";
import { ProjectPage } from "./pages/project";
import { Tree, registerInboxNavigation } from "./components/tree";
import type { ScreenLoader } from "./App";
import { createBrowserNotifications } from "./lib/notifications";
import {
  createRestoreWorkspace,
  getRestoreResult,
  postRestore,
  restorePendingNotice,
} from "./lib/settings-restore";
import { createRestoreConnection } from "./lib/restore-connection";
import { createIssueApi } from "./pages/issue/issue-api";
import { createIssueWorkspace } from "./pages/issue/issue-workspace";
import { createWorktreeApi } from "./lib/worktree-api";
import { createWorktreeWorkspace } from "./lib/worktree-workspace";

const reload = () => window.location.reload();
const restoreConnection = createRestoreConnection({
  fetcher: window.fetch.bind(window),
  origin: window.location.origin,
  storage: window.sessionStorage,
  reload: (requestId) => {
    restore.prepareReload(requestId);
    reload();
  },
});
const request = restoreConnection.request;
const navigation = createNavigation(
  parseRoute(`${window.location.pathname}${window.location.search}`),
  reload,
  (url) => controller.navigate(url),
);
const { controller, dispose } = createBrowserController(window, navigation.open);
const timer = {
  schedule: (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    return () => window.clearTimeout(id);
  },
};
const notices = createNotices(timer);
const buildCheck = createBuildCheck({
  build: __SUKUNA_BUILD_ID__,
  show: notices.showUpdate,
});
const stopWatchingChunks = buildCheck.watchChunks(window);
controller.options.notify = notices.notify;
const notifications = createBrowserNotifications({
  notify: notices.notify,
  title: (value) => {
    document.title = value;
  },
});
const reportSettingsError = (error: unknown) => {
  notices.notify(error instanceof Error ? error.message : "設定を読み込めませんでした。", "error");
};
const settings = createSettingsStore(createSettingsApi(request), reportSettingsError);
controller.options.keymap = settings.keymap;
const stopUsageCommand = registerUsageCommand(controller);
const projectUsage = createProjectUsageApi(request);
const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const formatTime = (at: number) => timeFormat.format(at);
const inboxApi = createInboxApi(request);
const inbox = new InboxStore(
  inboxApi,
  { ...timer, now: () => Date.now(), storage: window.sessionStorage },
  notifications.updateTitle,
);
const stopInboxNavigation = registerInboxNavigation(controller, inbox);
const restore = createRestoreWorkspace({
  controller,
  store: settings,
  formatTime,
  post: (id) => postRestore(request, id),
  getResult: (id) => getRestoreResult(request, id),
  schedule: timer.schedule,
  finish: (message, kind) => notices.replaceInfoWithResult(restorePendingNotice, message, kind),
  storage: window.sessionStorage,
});
const stopRestore = restore.start();
const conversationApi = createConversationApi(request);
const stockApi = createStockApi(request);
const conversations = createConversationWorkspace(
  conversationApi,
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
    files: createFilesApi(request),
    verifyConnection: (signal) => restoreConnection.verify(signal, buildCheck.observe),
    recap: { api: createRecapApi(request), storage: window.sessionStorage },
    progress: { api: createProgressApi(request), storage: window.sessionStorage },
    stock: stockApi,
    lifecycle: {
      api: createLifecycleApi(request),
      openExternal: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    notifications,
    settingsChanged: () => {
      void settings.refresh().catch(reportSettingsError);
    },
  },
);
const worktrees = createWorktreeWorkspace({
  browser: window,
  controller,
  api: createWorktreeApi(request),
  conversations: conversationApi,
  stock: stockApi,
});
const stopWorktrees = worktrees.start();
const projectSettings = {
  api: createProjectSettingsApi(request),
  projects: inbox.projects,
  subscribeInbox: (receive: Parameters<typeof conversations.subscribeChanges>[1]) =>
    conversations.subscribeChanges("inbox", receive),
  projectForConversation: conversations.projectForConversation,
};
const stopSettingsCommands = registerSettingsCommands(controller, projectSettings, settings);
const issues = createIssueWorkspace({
  controller,
  api: createIssueApi(request),
  id: ulid,
  storage: window.sessionStorage,
  subscribe: conversations.subscribeChanges,
  schedule: timer.schedule,
  subscribeConversation: conversations.subscribeIssueConversation,
  loadConversation: conversations.loadConversation,
  monitorConversation: conversations.issueMonitor,
  stopConversation: conversations.stopConversation,
  projectForConversation: conversations.projectForConversation,
  refreshListings: (id) => {
    void inbox.overview(id).refresh();
  },
});
const stopIssues = issues.start();
const loadScreen: ScreenLoader = async (route) => {
  if (route.kind === "home")
    return {
      kind: "ready",
      title: "一覧",
      fullWindow: true,
      content: <InboxPage store={inbox} controller={controller} />,
    };
  if (route.kind === "project" && route.id && !route.view) {
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
          onProjectShown={issues.rememberProject}
        />
      ),
    };
  }
  const issue = await issues.loadScreen(route);
  if (issue) return issue;
  return (
    loadSettingsScreen(route, controller, settings, formatTime, projectSettings) ??
    loadProjectUsageScreen(route, controller, projectUsage, formatTime) ??
    worktrees.loadScreen(route) ??
    conversations.loadScreen(route)
  );
};
const stopConversations = conversations.start();
const pagehide = () => {
  if (!restoreConnection.reloading()) conversations.pagehide();
};
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
  stopWatchingChunks();
  notices.dispose();
  window.removeEventListener("pagehide", pagehide);
  stopSettingsCommands();
  stopUsageCommand();
  stopRestore();
  stopIssues();
  stopConversations();
  stopWorktrees();
  stopInboxNavigation();
  inbox.dispose();
  document.removeEventListener("visibilitychange", visibility);
  dispose();
});
const connection = {
  snapshot: () => conversations.connection.snapshot() && !restore.restarting.snapshot(),
  subscribe(callback: () => void) {
    const dispose = [
      conversations.connection.subscribe(callback),
      restore.restarting.subscribe(callback),
    ];
    return () => dispose.forEach((unregister) => unregister());
  },
};
const loadIdentity = createIdentityLoader(restoreConnection.readIdentity);

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
            renderRight={(view) =>
              restore.right(view) ?? worktrees.renderRight(view) ?? conversations.renderRight(view)
            }
            connection={connection}
          />
        )}
      </AuthenticationGuard>
    </ShellBoundary>
  </StrictMode>,
);
