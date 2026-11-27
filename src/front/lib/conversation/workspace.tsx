import type { ScreenLoader } from "../../App";
import type { ServerMessage } from "../../../shared/ws";
import type { RightView } from "../../buffer/right-window";
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
import type { RecapApi } from "../recap/api";
import type { TabStorage } from "../recap/read-tracking";
import { Realtime, type RealtimeSocket } from "../realtime";
import { parseRoute } from "../routes";
import { ConversationApiError } from "./api";
import { ConversationSession, type ConversationEnvironment } from "./session";
import type { ConversationApi } from "./types";

export function createConversationWorkspace(
  api: ConversationApi,
  controller: BufferController,
  env: ConversationEnvironment,
  socket: () => RealtimeSocket,
  {
    recap,
    lifecycle: lifecycleOptions,
  }: {
    recap?: { api: RecapApi; storage: TabStorage };
    lifecycle?: LifecycleOptions;
  } = {},
) {
  const sessions = new Map<string, ConversationSession>();
  const active = new Set<ConversationSession>();
  const shown = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changes = new Map<string, Set<(message?: ServerMessage) => void>>();
  let connected = true;
  let visible = true;
  let currentSession: ConversationSession | null = null;
  const reload = (topic: string) => {
    changes.get(topic)?.forEach((receive) => receive());
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
    setTimeout: (callback, ms) => env.schedule(callback, ms),
    unavailable: (value) => {
      connected = !value;
      active.forEach((session) => session.connection(connected));
      listeners.forEach((listener) => listener());
    },
    reload,
    gap: reload,
    message: (message) => {
      active.forEach((session) => session.receive(message));
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
  const loadScreen: ScreenLoader = async (route) => {
    if (
      currentSession &&
      (route.kind !== "conversation" || route.id !== currentSession.id || route.view)
    ) {
      currentSession.recap?.leave();
      currentSession = null;
    }
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
    if (route.kind !== "conversation" || !route.id || route.view)
      return {
        kind: "error",
        error: {
          code: "not_found",
          message: "開いた対象が見つかりません。一覧から選び直してください。",
        },
      };
    let session = sessions.get(route.id);
    if (!session) {
      session = new ConversationSession(route.id, api, controller, env);
      if (recap)
        session.recap = new RecapSession(session, recap.api, recap.storage, (fn, ms) =>
          env.schedule(fn, ms),
        );
      sessions.set(route.id, session);
    }
    try {
      currentSession = session;
      session.recap?.visibility(visible);
      await session.load();
      return {
        kind: "ready",
        title: `会話: ${session.snapshot().data!.conversation.title}`,
        fullWindow: true,
        content: (
          <ConversationPage
            key={route.id}
            session={session}
            openAtTail={new URLSearchParams(route.query).get("tail") === "1"}
            subscribe={subscribe}
          />
        ),
      };
    } catch (error) {
      return {
        kind: "error",
        error: {
          code: error instanceof ConversationApiError ? error.code : "network_error",
          message: error instanceof Error ? error.message : "会話を取得できませんでした",
        },
      };
    }
  };
  return {
    loadScreen,
    connection,
    renderRight: (view: RightView) => {
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
      realtime.start();
      return () => {
        unregister();
        unregisterLifecycle?.();
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
