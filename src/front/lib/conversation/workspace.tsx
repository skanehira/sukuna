import { conversationActionHelp, conversationCommands } from "./keymap";
import type { ReadyScreen, ScreenLoader } from "../../App";
import type { ServerMessage } from "../../../shared/ws";
import type { RightView } from "../../buffer/right-window";
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
import type { ConversationApi, Conversation } from "./types";
import type { InboxStore } from "../inbox-store";

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
  }: {
    recap?: { api: RecapApi; storage: TabStorage };
    lifecycle?: LifecycleOptions;
    settingsChanged?: () => void;
    inbox?: Pick<InboxStore, "reload" | "receive">;
    notifications?: { receive(message: ServerMessage): void };
    files?: FilesApi;
    verifyConnection?: (signal: AbortSignal) => Promise<boolean>;
  } = {},
) {
  const sessions = new Map<string, ConversationSession>();
  const loadedSessions = new WeakSet<ConversationSession>();
  const active = new Set<ConversationSession>();
  const shown = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changes = new Map<string, Set<(message?: ServerMessage) => void>>();
  let connected = true;
  let visible = true;
  let currentSession: ConversationSession | null = null;
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
      active.forEach((session) => session.connection(connected));
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
  const getConversation = async (id: string) => {
    const { conversation } = await api.get(id);
    fileScopes.set(id, conversation);
    return conversation;
  };
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
    });
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
      const next = parseRoute(controller.options.url ?? "/");
      if (next.kind !== "conversation" || next.id !== session.id || next.view)
        session.recap?.leave();
      unsubscribe();
      unshow();
    };
  };
  const conversationScreen = (
    session: ConversationSession,
    route: Route,
    openAtTail = requestsConversationTail(route),
  ): ReadyScreen => {
    const seq = Number(new URLSearchParams(route.query).get("seq"));
    return {
      kind: "ready",
      title: `会話: ${session.snapshot().data!.conversation.title}`,
      fullWindow: true,
      content: (
        <ConversationPage
          key={session.id}
          session={session}
          subscribe={subscribe}
          openAtTail={openAtTail}
          recordSeq={Number.isSafeInteger(seq) && seq > 0 ? seq : undefined}
          positionKey={`${screenKey(route)}:main`}
        />
      ),
    };
  };
  const loadScreen: ScreenLoader = async (route) => {
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
    try {
      if (route.view && files) {
        const opening = files.takePrepared(route);
        if (opening) return files.render(route, opening.scope, opening);
        const conversation = await getConversation(route.id);
        const root = conversation.parentConversationId
          ? await getConversation(conversation.parentConversationId)
          : conversation;
        controller.update({});
        return files.render(route, root);
      }
      let session = sessions.get(route.id);
      if (!session) {
        session = new ConversationSession(route.id, api, controller, env);
        if (recap)
          session.recap = new RecapSession(session, recap.api, recap.storage, (fn, ms) =>
            env.schedule(fn, ms),
          );
        sessions.set(route.id, session);
      }
      currentSession = session;
      session.recap?.visibility(visible);
      await session.load();
      const parent = session.snapshot().data?.conversation.parentConversationId;
      if (files && parent && !storedConversation(parent)) await getConversation(parent);
      if (files) controller.update({});
      loadedSessions.add(session);
      return conversationScreen(session, route);
    } catch (error) {
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
    connection,
    renderRight: (view: RightView) => {
      if (view.view === "file-tree") return files?.tree(view.target) ?? null;
      if (["recent", "toc", "decisions", "recap-search"].includes(view.view)) {
        const recap = sessions.get(view.target)?.recap;
        return recap ? (
          <RecapPanel key={`${view.target}:${view.view}`} recap={recap} view={view.view} />
        ) : null;
      }
      if (view.view !== "conversation-switch") return lifecycle?.right(view) ?? null;
      const route = parseRoute(controller.options.url ?? "/");
      const currentProject =
        route.kind === "project"
          ? route.id
          : sessions.get(route.id ?? "")?.snapshot().data?.conversation.projectId;
      return (
        <ConversationSwitch api={api} controller={controller} currentProject={currentProject} />
      );
    },
    start() {
      const unregister = registerConversationSwitch(controller);
      const unregisterLifecycle = lifecycle?.start();
      const removeActionHelp = controller.actions.declareHelp([
        ...conversationActionHelp([
          ...(recap ? Object.values(recapItemActions) : []),
          ...(lifecycle ? [listDeleteAction] : []),
        ]),
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
      realtime.start();
      return () => {
        unregister();
        unregisterLifecycle?.();
        removeActionHelp();
        removeCommandHelp();
        unsubscribeApp?.();
        unsubscribeInbox?.();
        stopFiles?.();
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
