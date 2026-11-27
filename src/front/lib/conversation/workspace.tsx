import type { ScreenLoader } from "../../App";
import { Buffer } from "../../buffer/Buffer";
import type { BufferController } from "../../buffer/controller";
import {
  ConversationSwitch,
  registerConversationSwitch,
} from "../../components/conversation/ConversationSwitch";
import { ConversationPage } from "../../pages/conversation/ConversationPage";
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
) {
  const sessions = new Map<string, ConversationSession>();
  const active = new Set<ConversationSession>();
  const listeners = new Set<() => void>();
  let connected = true;
  const reload = (topic: string) => {
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
    message: (message) => active.forEach((session) => session.receive(message)),
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
    realtime.shown([...active].map((session) => `conversation:${session.id}`));
    return () => {
      active.delete(session);
      unsubscribe();
      realtime.shown([...active].map((session) => `conversation:${session.id}`));
    };
  };
  const loadScreen: ScreenLoader = async (route) => {
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
      sessions.set(route.id, session);
    }
    try {
      await session.load();
      return {
        kind: "ready",
        title: `会話: ${session.snapshot().data!.conversation.title}`,
        fullWindow: true,
        content: <ConversationPage key={route.id} session={session} subscribe={subscribe} />,
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
    renderRight: (view: { view: string }) => {
      if (view.view !== "conversation-switch") return null;
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
      realtime.start();
      return () => {
        unregister();
        realtime.stop();
      };
    },
    visibility: (visible: boolean) => realtime.visibility(visible),
  };
}
