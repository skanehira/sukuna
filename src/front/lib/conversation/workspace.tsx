import { queuedStockIds } from "../../../shared/conversation/api";
import { conversationActionHelp, conversationCommands } from "./keymap";
import type { ReadyScreen, ScreenLoader } from "../../App";
import type { ServerMessage } from "../../../shared/ws";
import { isTimelineView, type RightView } from "../../buffer/right-window";
import { listDeleteAction } from "../../components/lifecycle/ConversationList";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { createLifecycleWorkspace, type LifecycleOptions } from "../lifecycle/workspace";
import { Buffer } from "../../buffer/Buffer";
import type { BufferController } from "../../buffer/controller";
import {
  ConversationSwitch,
  registerConversationSwitch,
} from "../../components/conversation/ConversationSwitch";
import { ConversationPage } from "../../pages/conversation/ConversationPage";
import { RecapPanel } from "../../components/recap/RecapPanel";
import { RecapSession } from "../recap/session";
import { recapActions, recapCommands, recapItemActions } from "../recap/keymap";
import type { RecapApi } from "../recap/api";
import type { TabStorage } from "../recap/read-tracking";
import type { FilesApi } from "../files/api";
import { createFileRealtime } from "../files/realtime";
import { createFilesWorkspace, filesRouteViews } from "../files/workspace";
import { Realtime, type RealtimeSocket } from "../realtime";
import { parseRoute, requestsConversationTail, screenKey, type Route } from "../routes";
import { ConversationApiError } from "./api";
import { ConversationSession, type ConversationEnvironment } from "./session";
import type { ConversationApi, Conversation, Snapshot } from "./types";
import type { StockApi } from "../stock/api";
import { conversationSource } from "../stock/quote";
import { createStockWorkspace } from "../stock/workspace";
import type { InboxStore } from "../inbox-store";
import { MonitorPane, WorkingActivity, WorkMonitor, type WorkMonitorOptions } from "./work-monitor";
import { timelineActions } from "../work-actions";

export function createConversationWorkspace(
  api: ConversationApi,
  controller: BufferController,
  env: ConversationEnvironment,
  socket: () => RealtimeSocket,
  {
    recap,
    files: filesApi,
    lifecycle: lifecycleOptions,
    settingsChanged,
    inbox,
    notifications,
    verifyConnection,
    progress,
    stock: stockApi,
  }: {
    progress?: Pick<WorkMonitorOptions, "api" | "storage" | "motion">;
    recap?: { api: RecapApi; storage: TabStorage };
    lifecycle?: LifecycleOptions;
    settingsChanged?: () => void;
    inbox?: Pick<InboxStore, "reload" | "receive">;
    notifications?: { receive(message: ServerMessage): void };
    files?: FilesApi;
    verifyConnection?: (signal: AbortSignal) => Promise<boolean>;
    stock?: StockApi;
  } = {},
) {
  const sessions = new Map<string, ConversationSession>();
  const loadedSessions = new WeakSet<ConversationSession>();
  const active = new Set<ConversationSession>();
  const reviewDrafts = new Set<ConversationSession>();
  let stopReviewDraftFeed: (() => void) | undefined;
  const rightTimelines = new Set<ConversationSession>();
  const shown = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changes = new Map<string, Set<(message?: ServerMessage) => void>>();
  let connected = true;
  let visible = true;
  let currentSession: ConversationSession | null = null;
  let currentIssueMonitor: WorkMonitor | undefined;
  const issueMonitors = new WeakMap<ConversationSession, WorkMonitor>();
  let resolvedFile: { opening: number; id: string; available: boolean } | undefined;
  const releaseUnavailableFileFocus = () => {
    if (resolvedFile?.opening !== controller.screenOpening()) return;
    const right = controller.right.current;
    if (
      right &&
      isTimelineView(right.view) &&
      (!resolvedFile.available || right.target !== resolvedFile.id)
    )
      controller.focusMainFromRight();
  };
  const draftChanged = (message?: ServerMessage) =>
    !message ||
    (message.type === "changed" &&
      (!message.payload.parts || message.payload.parts.includes("draft")));
  const reload = (topic: string) => {
    if (topic === "app") settingsChanged?.();
    changes.get(topic)?.forEach((receive) => receive());
    if (topic === "inbox") void inbox?.reload();
    fileRealtime?.reload(topic);
    for (const session of active)
      if (topic === `conversation:${session.id}`)
        void session
          .load()
          .catch((error: unknown) =>
            controller.notify(
              error instanceof Error ? error.message : "会話を取得できませんでした",
              "error",
            ),
          );
  };
  const realtime = new Realtime({
    connect: socket,
    verifyConnection,
    setTimeout: (callback, ms) => env.schedule(callback, ms),
    unavailable: (value) => {
      connected = !value;
      if (!value) fileRealtime?.connected();
      for (const session of new Set([...active, ...rightTimelines, ...reviewDrafts]))
        session.connection(connected);
      listeners.forEach((listener) => listener());
    },
    reload,
    gap: reload,
    message: (message) => {
      inbox?.receive(message);
      notifications?.receive(message);
      if (message.topic === "app" && message.type === "settings_changed") settingsChanged?.();
      active.forEach((session) => session.receive(message));
      fileRealtime?.receive(message);
      if (message.type !== "resync")
        changes.get(message.topic)?.forEach((receive) => receive(message));
    },
  });
  const projectForConversation = (id: string) => storedConversation(id)?.projectId;
  const subscribeChanges: LifecycleFeed = (topic, receive, from) => {
    const receivers = changes.get(topic) ?? new Set();
    receivers.add(receive);
    changes.set(topic, receivers);
    const after = topic.startsWith("conversation:")
      ? sessions.get(topic.slice("conversation:".length))?.receivedThrough()
      : undefined;
    const unsubscribe = realtime.subscribe(topic, from ?? after);
    return () => {
      receivers.delete(receive);
      if (receivers.size === 0) changes.delete(topic);
      unsubscribe();
    };
  };
  const showConversation = (id: string) => {
    const topic = `conversation:${id}`;
    const count = shown.get(topic) ?? 0;
    shown.set(topic, count + 1);
    if (count === 0) realtime.shown([...shown.keys()]);
    return () => {
      const count = shown.get(topic) ?? 0;
      if (count > 1) {
        shown.set(topic, count - 1);
      } else {
        shown.delete(topic);
        realtime.shown([...shown.keys()]);
      }
    };
  };
  type OpenFile = (id: string, path: string, line: number, col: number) => void | Promise<void>;
  let openStockFile: OpenFile | undefined;
  const stock =
    stockApi &&
    createStockWorkspace({
      api: stockApi,
      controller,
      conversations: api,
      env,
      subscribe: subscribeChanges,
      showConversation,
      lookup: (id) => storedConversation(id),
      openFile: (id, path, line, col) => openStockFile?.(id, path, line, col),
      queuedId: (id, item) =>
        sessions
          .get(id)
          ?.snapshot()
          .data?.queue.find((queued) => queuedStockIds(queued).includes(item))?.id,
    });
  const lifecycle =
    lifecycleOptions &&
    createLifecycleWorkspace({
      ...lifecycleOptions,
      controller,
      conversations: api,
      clock: env,
      showConversation,
      subscribe: subscribeChanges,
      lookup: (id) => sessions.get(id)?.snapshot().data?.conversation,
    });
  const fileScopes = new Map<string, Conversation>();
  const storedConversation = (id: string) =>
    sessions.get(id)?.snapshot().data?.conversation ?? fileScopes.get(id);
  const getSnapshot = async (id: string) => {
    const snapshot = await api.get(id);
    fileScopes.set(id, snapshot.conversation);
    return snapshot;
  };
  const getConversation = async (id: string) => (await getSnapshot(id)).conversation;
  const fileRealtime =
    filesApi &&
    createFileRealtime(
      realtime,
      filesApi,
      getConversation,
      (id, after) => api.events(id, after),
      (message) => controller.notify(message, "error"),
      (id) => [...active].find((session) => session.id === id)?.receivedThrough(),
    );
  const files =
    filesApi &&
    fileRealtime &&
    createFilesWorkspace({
      api: filesApi,
      controller,
      scope: (id) => {
        const conversation = storedConversation(id);
        const root = conversation?.parentConversationId
          ? storedConversation(conversation.parentConversationId)
          : conversation;
        if (!root) return undefined;
        return {
          id: root.id,
          cwd: root.cwd,
          lastSeq: Math.max(root.lastSeq, sessions.get(root.id)?.receivedThrough() ?? 0),
        };
      },
      schedule: (callback, ms) => env.schedule(callback, ms),
      watch: (scope, listener, replaySignal) =>
        fileRealtime.subscribe(scope, listener, replaySignal),
      prepare: (scope, signal) => fileRealtime.prepare(scope, signal),
      readStart: fileRealtime.readStart,
      refreshScope: getConversation,
      entryId: () => env.id(),
      stock: stock?.session,
    });
  openStockFile = files?.openFile;
  const connection = {
    snapshot: () => connected,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const subscribe = (session: ConversationSession) => {
    active.add(session);
    session.connection(connected);
    const unsubscribe = realtime.subscribe(`conversation:${session.id}`, session.receivedThrough());
    const unshow = showConversation(session.id);
    return () => {
      active.delete(session);
      unsubscribe();
      unshow();
    };
  };
  const subscribeConversation = (session: ConversationSession) => {
    const stop = subscribe(session);
    return () => {
      stop();
      const next = parseRoute(controller.options.url ?? "/");
      if (next.kind !== "conversation" || next.id !== session.id || next.view)
        session.recap?.leave();
    };
  };
  const loadConversation = async (
    id: string,
    current?: () => boolean,
  ): Promise<ConversationSession> => {
    const session = sessionFor(id);
    session.recap?.visibility(visible);
    await session.load(current);
    return session;
  };
  const issueMonitor = (session: ConversationSession, id: string) => {
    if (!progress) return undefined;
    const found = issueMonitors.get(session);
    if (found?.target.id === id) return found;
    const monitor = new WorkMonitor(
      session,
      { ...progress, now: () => env.now(), schedule: (fn, ms) => env.schedule(fn, ms) },
      { kind: "issue", id },
    );
    issueMonitors.set(session, monitor);
    return monitor;
  };
  const subscribeIssueConversation = (session: ConversationSession, monitor?: WorkMonitor) => {
    currentSession = session;
    currentIssueMonitor = monitor;
    const conversation = session.snapshot().data?.conversation;
    const leaveStock =
      conversation?.kind === "design" && conversation.issueId
        ? stock?.enterIssue(conversation, conversation.issueId)
        : undefined;
    if (!leaveStock) stock?.leave();
    const stop = subscribe(session);
    controller.update({});
    return () => {
      stop();
      leaveStock?.();
      if (monitor && currentIssueMonitor === monitor) {
        currentIssueMonitor = undefined;
        controller.update({});
      }
      queueMicrotask(() => {
        if (active.has(session)) return;
        session.recap?.leave();
        if (currentSession === session) currentSession = null;
      });
    };
  };
  const subscribeTimeline = (monitor: WorkMonitor) => {
    const id = monitor.conversationId;
    const session = sessions.get(id);
    const disconnect = monitor.connect();
    if (session) {
      rightTimelines.add(session);
      if (!active.has(session)) session.connection(connected);
    }
    const unsubscribe = subscribeChanges(`conversation:${id}`, (message) => {
      if (session && active.has(session)) return;
      if (message) monitor.receive(message);
      else monitor.loaded();
    });
    const unshow = showConversation(id);
    return () => {
      if (session) rightTimelines.delete(session);
      unshow();
      unsubscribe();
      disconnect();
    };
  };
  const sessionFor = (id: string, initial?: Snapshot) => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = new ConversationSession(id, api, controller, env, { initial });
    if (recap)
      session.recap = new RecapSession(session, recap.api, recap.storage, (fn, ms) =>
        env.schedule(fn, ms),
      );
    if (progress)
      session.monitor = new WorkMonitor(session, {
        ...progress,
        now: () => env.now(),
        schedule: (fn, ms) => env.schedule(fn, ms),
      });
    sessions.set(id, session);
    return session;
  };
  const hasSavedTimeline = (id: string) => {
    const { current, stack } = controller.right.state();
    return [current, ...stack].some((view) => view?.target === id && isTimelineView(view.view));
  };
  const conversationScreen = (
    session: ConversationSession,
    route: Route,
    openAtTail = requestsConversationTail(route),
  ): ReadyScreen => {
    const params = new URLSearchParams(route.query);
    const seq = Number(params.get("seq"));
    const nonnegative = (name: string) => {
      const value = params.get(name);
      const n = Number(value);
      return value !== null && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    };
    return {
      kind: "ready",
      title: `会話: ${session.snapshot().data!.conversation.title}`,
      fullWindow: true,
      content: (
        <ConversationPage
          key={session.id}
          session={session}
          subscribe={subscribeConversation}
          openAtTail={openAtTail}
          recordSeq={Number.isSafeInteger(seq) && seq > 0 ? seq : undefined}
          recordLine={nonnegative("quoteLine")}
          recordColumn={nonnegative("quoteColumn")}
          queuedStockId={params.get("stock") || undefined}
          marks={stock?.session(session.id).bufferMarks(conversationSource)}
          positionKey={`${screenKey(route)}:main`}
          activity={
            session.monitor ? (
              <WorkingActivity monitor={session.monitor} session={session} />
            ) : undefined
          }
        />
      ),
    };
  };
  const loadScreen: ScreenLoader = async (route) => {
    const openingId = controller.screenOpening();
    const onScreen = () => controller.screenOpening() === openingId;
    if (route.kind !== "conversation") stock?.leave();
    if (
      currentSession &&
      (route.kind !== "conversation" || route.id !== currentSession.id || route.view)
    ) {
      currentSession.recap?.leave();
      currentSession = null;
    }
    const openAtTail = requestsConversationTail(route);
    const lifecycleScreen = lifecycle?.screen(route);
    if (lifecycleScreen) return lifecycleScreen;
    if (route.kind === "home")
      return {
        kind: "ready",
        title: "一覧",
        content: (
          <Buffer
            side="main"
            lines={[{ kind: "note", text: "表示する項目はありません。" }]}
            onReady={() => {}}
          />
        ),
      };
    if (
      route.kind !== "conversation" ||
      !route.id ||
      (route.view && (!files || !filesRouteViews.has(route.view)))
    )
      return {
        kind: "error",
        error: {
          code: "not_found",
          message: "開いた対象が見つかりません。一覧から選び直してください。",
        },
      };
    const openingRevision = controller.screenOpening();
    const hasTimelineFile = progress !== undefined && route.view === "file";
    const id = route.id;
    const resolveFile = (available: boolean, initial?: Snapshot) => {
      if (!hasTimelineFile) return;
      const current = parseRoute(controller.options.url ?? "/");
      if (
        openingRevision !== controller.screenOpening() ||
        screenKey(route) !== screenKey({ ...current, entry: controller.options.entry }) ||
        (openingRevision === resolvedFile?.opening && available === resolvedFile.available)
      )
        return;
      resolvedFile = { opening: openingRevision, id, available };
      if (available && initial && hasSavedTimeline(id)) sessionFor(id, initial);
      releaseUnavailableFileFocus();
      controller.update({});
    };
    try {
      if (route.view && files) {
        const opening = files.takePrepared(route);
        const restoreTimeline = hasTimelineFile && hasSavedTimeline(id);
        const fileResolved = (initial?: Snapshot) =>
          hasTimelineFile ? (available: boolean) => resolveFile(available, initial) : undefined;
        if (opening && (!restoreTimeline || sessions.has(id))) {
          const root = storedConversation(opening.scope.id);
          if (root && onScreen()) stock?.enter(root);
          return files.render(route, opening.scope, opening, fileResolved());
        }
        const initial = await getSnapshot(id);
        const conversation = initial.conversation;
        const root = conversation.parentConversationId
          ? await getConversation(conversation.parentConversationId)
          : conversation;
        if (onScreen()) stock?.enter(root);
        controller.update({});
        return files.render(route, root, opening, fileResolved(initial));
      }
      const session = await loadConversation(route.id);
      if (onScreen()) currentSession = session;
      const parent = session.snapshot().data?.conversation.parentConversationId;
      if (files && parent && !storedConversation(parent)) await getConversation(parent);
      if (files) controller.update({});
      if (onScreen()) {
        const conversation = session.snapshot().data!.conversation;
        if (conversation.kind !== "thread") stock?.enter(conversation);
        else stock?.leave();
      }
      loadedSessions.add(session);
      return conversationScreen(session, route);
    } catch (error) {
      resolveFile(false);
      const code = error instanceof ConversationApiError ? error.code : "network_error";
      const cachedSession = sessions.get(route.id);
      return {
        kind: "error",
        error: {
          code,
          message: error instanceof Error ? error.message : "会話を取得できませんでした",
        },
        ...(code === "network_error" &&
        openAtTail &&
        cachedSession &&
        loadedSessions.has(cachedSession)
          ? { cached: conversationScreen(cachedSession, route, false) }
          : {}),
      };
    }
  };
  return {
    loadScreen,
    loadConversation,
    enterIssueStock: stock?.enterIssue,
    stockSession: stock?.session,
    stopConversation: api.stop,
    issueMonitor,
    subscribeIssueConversation,
    reviewStock: stock,
    watchReviewDraft(this: void, id: string, current: () => boolean) {
      const session = sessionFor(id);
      return subscribeChanges(`conversation:${id}`, (message) => {
        if (!current() || active.has(session) || !draftChanged(message)) return;
        void session.refresh(false, current).catch(() => {});
      });
    },
    trackReviewDraft(this: void, session: ConversationSession) {
      if (!reviewDrafts.has(session)) {
        reviewDrafts.add(session);
        if (!active.has(session) && !rightTimelines.has(session)) session.connection(connected);
      }
      const { promptId } = controller.snapshot();
      const opening = controller.screenOpening();
      let watching = true;
      const current = () => {
        const state = controller.snapshot();
        return (
          watching &&
          opening === controller.screenOpening() &&
          state.promptId === promptId &&
          state.prompt?.scope === session.id
        );
      };
      if (!current()) return;
      stopReviewDraftFeed?.();
      const unsubscribe = subscribeChanges(`conversation:${session.id}`, (message) => {
        if (!current() || active.has(session) || !draftChanged(message)) return;
        void session.refresh(false, current).catch((error: unknown) => {
          if (current())
            controller.notify(
              error instanceof Error ? error.message : "書きかけを取得できませんでした",
              "error",
            );
        });
      });
      const stopWatching = controller.subscribe(() => {
        if (!current()) stop();
      });
      const stop = () => {
        if (!watching) return;
        watching = false;
        stopWatching();
        unsubscribe();
        if (stopReviewDraftFeed === stop) stopReviewDraftFeed = undefined;
      };
      stopReviewDraftFeed = stop;
      return stop;
    },
    connection,
    renderRight: (view: RightView) => {
      const stockPanel = stock?.right(view);
      if (stockPanel) return stockPanel;
      if (view.view === "file-tree") return files?.tree(view.target) ?? null;
      if (isTimelineView(view.view)) {
        const route = parseRoute(controller.options.url ?? "/");
        if (route.kind === "issue") {
          const monitor = currentIssueMonitor;
          return monitor && route.id === view.target && monitor.target.id === view.target ? (
            <MonitorPane
              key={monitor.conversationId}
              monitor={monitor}
              view={view.view}
              subscribe={subscribeTimeline}
            />
          ) : null;
        }
        if (
          route.kind !== "conversation" ||
          route.id !== view.target ||
          (route.view &&
            (route.view !== "file" ||
              resolvedFile?.opening !== controller.screenOpening() ||
              !resolvedFile.available))
        )
          return null;
        const monitor = sessions.get(view.target)?.monitor;
        return monitor ? (
          <MonitorPane
            key={view.target}
            monitor={monitor}
            view={view.view}
            subscribe={subscribeTimeline}
          />
        ) : null;
      }
      if (["recent", "toc", "decisions", "recap-search"].includes(view.view)) {
        const recap = sessions.get(view.target)?.recap;
        return recap ? (
          <RecapPanel key={`${view.target}:${view.view}`} recap={recap} view={view.view} />
        ) : null;
      }
      if (view.view !== "conversation-switch") return lifecycle?.right(view) ?? null;
      const route = parseRoute(controller.options.url ?? "/");
      const currentProject =
        route.kind === "project" ? route.id : projectForConversation(route.id ?? "");
      return (
        <ConversationSwitch api={api} controller={controller} currentProject={currentProject} />
      );
    },
    projectForConversation,
    subscribeChanges,
    start() {
      const unregister = registerConversationSwitch(controller);
      const unregisterLifecycle = lifecycle?.start();
      const unsubscribeFileFocus = progress && controller.subscribe(releaseUnavailableFileFocus);
      const unregisterTimeline = progress
        ? controller.actions.register({
            ...timelineActions.open,
            group: "そのほか",
            run: () => {
              const route = parseRoute(controller.options.url ?? "/");
              if (
                currentIssueMonitor &&
                route.kind === "issue" &&
                route.id === currentIssueMonitor.target.id
              )
                currentIssueMonitor.open();
              else if (
                currentSession?.monitor &&
                route.kind === "conversation" &&
                route.id === currentSession.id &&
                !route.view
              )
                currentSession.monitor.open();
              else controller.notify("会話か issue を開くと、タイムラインを使えます。");
            },
          })
        : undefined;
      const removeActionHelp = controller.actions.declareHelp([
        ...conversationActionHelp(
          [
            ...(recap ? Object.values(recapItemActions) : []),
            ...(lifecycle ? [listDeleteAction] : []),
          ],
          progress !== undefined,
        ),
        ...(progress ? Object.values(timelineActions) : []),
        ...(recap ? Object.values(recapActions) : []),
      ]);
      const removeCommandHelp = controller.commands.declareHelp([
        ...Object.values(conversationCommands),
        ...(recap ? Object.values(recapCommands) : []),
      ]);
      const unsubscribeApp =
        settingsChanged || notifications ? realtime.subscribe("app") : undefined;
      const unsubscribeInbox = inbox ? realtime.subscribe("inbox") : undefined;
      const stopFiles = files?.start();
      const stopStock = stock?.start();
      realtime.start();
      return () => {
        unregister();
        unregisterTimeline?.();
        unregisterLifecycle?.();
        unsubscribeFileFocus?.();
        removeActionHelp();
        removeCommandHelp();
        unsubscribeApp?.();
        unsubscribeInbox?.();
        stopFiles?.();
        stopStock?.();
        stopReviewDraftFeed?.();
        realtime.stop();
      };
    },
    pagehide: () => currentSession?.recap?.pagehide(),
    visibility: (value: boolean) => {
      visible = value;
      currentSession?.recap?.visibility(value);
      realtime.visibility(value);
    },
  };
}
