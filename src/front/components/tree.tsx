import { useSyncExternalStore } from "react";
import type { ProjectsResponse } from "../../shared/inbox/schema";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import type { LineInfo } from "../buffer/line";
import type { InboxStore } from "../lib/inbox-store";
import { routeUrl, type Route } from "../lib/routes";
import { ListingBuffer } from "./listing-buffer";

function treeLines(data: ProjectsResponse | null, route: Route): LineInfo[] {
  const current = routeUrl({ kind: route.kind, id: route.id });
  const line = (
    id: string,
    text: string,
    url: string,
    kind: "tree" | "heading" = "tree",
  ): LineInfo => ({
    kind,
    id,
    text,
    target: { url },
    ...(url === current ? { mark: "›" } : {}),
  });
  return [
    line("home", "一覧", "/"),
    ...(data?.projects.flatMap((project) => [
      line(
        `project:${project.id}`,
        `${project.name}${project.flowPaused ? " (自動フロー停止中)" : ""}`,
        `/projects/${encodeURIComponent(project.id)}`,
        "heading",
      ),
      ...project.conversations.map((conversation) =>
        line(
          `conversation:${conversation.id}`,
          `  会話: ${conversation.title || "(題名なし)"}`,
          `/conversations/${encodeURIComponent(conversation.id)}`,
        ),
      ),
      ...project.issues.map((issue) =>
        line(
          `issue:${issue.id}`,
          `  #${issue.number} ${issue.title}`,
          `/issues/${encodeURIComponent(issue.id)}`,
        ),
      ),
    ]) ?? []),
    { kind: "heading", text: "アプリ" },
    line("settings", "設定", "/settings"),
    line("help", "ヘルプ", "/help"),
  ];
}
export function Tree({ store, route }: { store: InboxStore; route: Route }) {
  const state = useSyncExternalStore(store.projects.subscribe, store.projects.snapshot);
  return (
    <Frame title="sukuna" side="tree">
      <ListingBuffer
        ready={state.data !== null}
        side="tree"
        viewName="tree"
        posKey="tree"
        lines={treeLines(state.data, route)}
      />
      {state.error ? (
        <div role="alert" className="px-3 py-2 text-xs text-wait">
          {state.error.message}
        </div>
      ) : null}
    </Frame>
  );
}
export function registerInboxNavigation(controller: BufferController, store: InboxStore) {
  const home = () => controller.navigate("/");
  const removers = [
    controller.actions.register({
      name: "home",
      label: "一覧",
      group: "開く・戻る",
      where: "どこでも",
      run: home,
    }),
    ...["home", "ls"].map((name) =>
      controller.commands.register({ name, label: "一覧", run: home }),
    ),
    controller.commands.register({
      name: "project",
      label: "プロジェクトを開く",
      run: async (args) => {
        const prefix = args.join(" ");
        if (!prefix) {
          controller.notify("使い方: :project <名前>");
          return;
        }
        await store.projects.load();
        const state = store.projects.snapshot();
        if (state.error) {
          controller.notify(state.error.message, "error");
          return;
        }
        const matches =
          state.data?.projects.filter((project) => project.name.startsWith(prefix)) ?? [];
        if (matches.length !== 1) {
          controller.notify(matches.length === 0 ? "プロジェクトが見つかりません" : "複数あります");
          return;
        }
        await controller.navigate(`/projects/${encodeURIComponent(matches[0].id)}`);
      },
    }),
  ];
  return () => removers.forEach((remove) => remove());
}
