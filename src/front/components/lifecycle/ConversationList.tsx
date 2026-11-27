import { useMemo } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 一覧を表示中だけバッファのキー操作を登録する
import { useEffect } from "react";
import type { BufferController } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import type { ActionInfo } from "../../buffer/keymap/registry";
import type { LineInfo } from "../../buffer/line";
import { conversationActions } from "../../lib/conversation/keymap";
import type { ConversationApi } from "../../lib/conversation/types";
import type { LifecycleApi } from "../../lib/lifecycle/api";
import {
  conversationUrl,
  groupsForProjects,
  lifecycleColumns,
  lifecycleLine,
  lifecycleRowId,
  singleLine,
  type LifecycleRow,
} from "../../lib/lifecycle/rows";
import { LifecycleBuffer } from "./LifecycleBuffer";
import {
  inboxChanged,
  type LifecycleClock,
  useElapsedClock,
  useLifecycleData,
  type LifecycleFeed,
} from "./use-lifecycle";

export const listTitle = "会話とスレッドの一覧";
export const listView = "conversation-list";
export const listDeleteAction = {
  name: conversationActions.deleteItem.name,
  label: "会話・スレッドを削除する",
  group: "会話",
  where: "会話一覧",
  views: [listView],
} satisfies ActionInfo;
const issueDelete = "issue は、プロジェクトの画面で dd を押して取り下げます";

export function ConversationList({
  api,
  conversations,
  controller,
  subscribe,
  clock,
}: {
  api: LifecycleApi;
  conversations: ConversationApi;
  controller: BufferController;
  subscribe: LifecycleFeed;
  clock: LifecycleClock;
}) {
  const { data, error, mutate } = useLifecycleData(
    ["conversation-list", api, conversations],
    async () => {
      const projects = await conversations.projects();
      return Promise.all(
        projects.map(async (project) => ({
          project,
          listing: await api.projectConversations(project.id),
        })),
      );
    },
    subscribe,
    "inbox",
    inboxChanged,
  );
  const groups = useMemo(() => groupsForProjects(data ?? []), [data]);
  const now = useElapsedClock(clock);
  const rows = useMemo(
    () =>
      new Map(
        groups
          .flatMap((group) => [group, ...group.threads])
          .map((row) => [lifecycleRowId(row), row]),
      ),
    [groups],
  );
  const lines = useMemo((): LineInfo[] => {
    if (!data)
      return [{ kind: error ? "note" : "skeleton", text: error ? errorText(error) : "読み込み中" }];
    const items = groups.flatMap((group) => [
      lifecycleLine(group, group.projectName, now),
      ...group.threads.map((thread) => lifecycleLine(thread, group.projectName, now, true)),
    ]);
    if (error) items.unshift({ kind: "note", text: errorText(error) });
    if (groups.length === 0)
      items.push({ kind: "note", text: "会話はまだありません。Space n で始めます" });
    return [
      ...items,
      {
        kind: "note",
        text: "閉じた会話は、開くと読めます。続きを書いて送ると再開し、一覧に戻ります。",
      },
    ];
  }, [data, error, groups, now]);
  useEffect(() => {
    const current = () => rows.get(controller.currentLine()?.id ?? "");
    const removeDelete = controller.actions.register({
      ...listDeleteAction,
      run: (context) => {
        if (controller.busy(context.window)) return;
        const selected = current();
        if (!selected) return;
        if (selected.kind === "issue") {
          controller.notify(issueDelete);
          return;
        }
        const name = singleLine(selected.title);
        const confirmation =
          selected.kind === "chat"
            ? "「" + name + "」とそのスレッドを削除しますか? 取り消せません"
            : "「スレッド: " + name + "」を削除しますか? 取り消せません";
        controller.confirm(confirmation, context, async () => {
          const result = await api.remove(selected.id);
          const deleted = new Set(result.deleted);
          await mutate(
            (projects) =>
              projects?.map(({ project, listing }) => ({
                project,
                listing: {
                  conversations: listing.conversations
                    .filter((chat) => !deleted.has(chat.id))
                    .map((chat) => ({
                      ...chat,
                      threads: chat.threads.filter((thread) => !deleted.has(thread.id)),
                    })),
                  issueThreads: listing.issueThreads.map((group) => ({
                    ...group,
                    threads: group.threads.filter((thread) => !deleted.has(thread.id)),
                  })),
                },
              })),
            { revalidate: false },
          );
          void mutate().catch(() => {});
          controller.notify(
            selected.kind === "chat"
              ? "会話とそのスレッドを削除しました"
              : "スレッドを削除しました",
          );
        });
      },
    });
    const removeOpen = controller.actions.register({
      name: "lifecycle.open-thread",
      label: "元の会話とスレッドを開く",
      group: "開く・戻る",
      where: listTitle,
      views: [listView],
      run: async (context) => {
        const selected: LifecycleRow | undefined = current();
        if (selected?.kind !== "thread") return;
        const { conversation } = await conversations.get(selected.id);
        if (controller.options.url !== "/convs") return;
        if (conversation.kind !== "thread" || !conversation.parentConversationId)
          throw new Error("元の会話が見つかりませんでした");
        controller.pushJump(context.window, context.line);
        await controller.navigate(conversationUrl(conversation.parentConversationId, selected.id));
      },
    });
    return () => {
      removeDelete();
      removeOpen();
    };
  }, [api, controller, conversations, mutate, rows]);
  return (
    <Frame title={listTitle} side="list" columns={lifecycleColumns}>
      <LifecycleBuffer
        side="list"
        viewName={listView}
        lines={lines}
        columns={lifecycleColumns}
        temporary={!data}
      />
    </Frame>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? singleLine(error.message) : "会話の一覧を取得できませんでした";
}
