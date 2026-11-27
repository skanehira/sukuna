import type { ScreenContent } from "../../App";
import type { BufferController } from "../../buffer/controller";
import type { RightView } from "../../buffer/right-window";
import { ClosingWindow, closingView } from "../../components/lifecycle/ClosingWindow";
import { ConversationList, listTitle, listView } from "../../components/lifecycle/ConversationList";
import { SearchResults, searchTitle, searchView } from "../../components/lifecycle/SearchResults";
import { ThreadPreview, threadView } from "../../components/lifecycle/ThreadPreview";
import type { LifecycleClock, LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import type { Conversation, ConversationApi } from "../conversation/types";
import { parseRoute, routeUrl, type Route } from "../routes";
import type { LifecycleApi } from "./api";

export type LifecycleOptions = { api: LifecycleApi; openExternal: (url: string) => void };

export function createLifecycleWorkspace({
  api,
  controller,
  conversations,
  subscribe,
  clock,
  showConversation,
  lookup,
  openExternal,
}: LifecycleOptions & {
  controller: BufferController;
  conversations: ConversationApi;
  subscribe: LifecycleFeed;
  clock: LifecycleClock;
  showConversation: (id: string) => () => void;
  lookup: (id: string) => Conversation | undefined;
}) {
  const openClose = () => {
    const route = parseRoute(controller.options.url ?? "/");
    const conversation = route.id ? lookup(route.id) : undefined;
    if (
      route.kind === "issue" ||
      (route.kind === "conversation" && conversation?.kind === "issue")
    ) {
      controller.notify(
        "締めくくれるのは会話です。issue は、プロジェクトの画面で dd を押して取り下げます",
      );
      return;
    }
    if (route.kind === "conversation" && !route.view && conversation?.kind === "chat") {
      controller.openRight({ view: "closing", target: conversation.id });
      return;
    }
    controller.notify("締めくくる操作は会話の表示で使えます");
  };
  const openList = () => controller.navigate("/convs");
  const find = (args: string[]) => {
    const q = args.join(" ").trim();
    if (!q) return controller.notify("検索する語を入れてください", "error");
    if (Array.from(q).length > 200)
      return controller.notify("検索する語は 200 文字までです", "error");
    return controller.navigate(
      routeUrl({ kind: "search", query: new URLSearchParams({ q }).toString() }),
    );
  };
  return {
    start() {
      controller.setHints(listView, [
        ["open", "開く"],
        ["item.delete", "削除"],
        ["back", "戻る"],
      ]);
      controller.setHints(searchView, [
        ["open", "開く"],
        ["back", "戻る"],
      ]);
      for (const view of [closingView, threadView])
        controller.setHints(view, [["right.close", "閉じる"]]);
      const unregister = [
        controller.actions.register({
          name: "conversation.close",
          label: "会話を締めくくる",
          group: "開く・戻る",
          where: "会話",
          views: ["conversation", "issue"],
          run: openClose,
        }),
        controller.actions.register({
          name: "conversation.list",
          label: listTitle,
          group: "開く・戻る",
          where: "どこでも",
          run: openList,
        }),
        controller.actions.register({
          name: "search.open",
          label: searchTitle,
          group: "開く・戻る",
          where: "どこでも",
          run: () => controller.openCommand("find "),
        }),
        controller.commands.register({ name: "close", label: "会話を締めくくる", run: openClose }),
        controller.commands.register({ name: "convs", label: listTitle, run: openList }),
        controller.commands.register({ name: "find", label: searchTitle, run: find }),
      ];
      return () => unregister.forEach((remove) => remove());
    },
    screen(route: Route): ScreenContent | undefined {
      if (route.kind === "convs")
        return {
          kind: "ready",
          fullWindow: true,
          title: listTitle,
          content: (
            <ConversationList
              api={api}
              conversations={conversations}
              controller={controller}
              subscribe={subscribe}
              clock={clock}
            />
          ),
        };
      if (route.kind !== "search") return;
      const query = new URLSearchParams(route.query).get("q")?.trim() ?? "";
      if (Array.from(query).length > 200)
        return {
          kind: "error",
          error: { code: "invalid_input", message: "検索する語は 200 文字までです" },
        };
      return {
        kind: "ready",
        fullWindow: true,
        title: searchTitle,
        content: (
          <SearchResults
            query={query}
            api={api}
            conversations={conversations}
            subscribe={subscribe}
            clock={clock}
          />
        ),
      };
    },
    right(view: RightView) {
      if (view.view === closingView) {
        const title = lookup(view.target)?.title ?? "";
        return (
          <ClosingWindow
            key={view.target}
            id={view.target}
            conversationTitle={title}
            api={api}
            subscribe={subscribe}
            controller={controller}
            openExternal={openExternal}
          />
        );
      }
      if (view.view === threadView) {
        const route = parseRoute(controller.options.url ?? "/");
        if (route.kind !== "conversation" || !route.id || route.thread !== view.target) return null;
        return (
          <ThreadPreview
            key={view.target}
            id={view.target}
            parentId={route.id}
            api={conversations}
            subscribe={subscribe}
            showConversation={showConversation}
          />
        );
      }
      return null;
    },
  };
}
