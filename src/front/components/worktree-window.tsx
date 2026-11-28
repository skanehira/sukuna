import { useCallback, useMemo, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: Vim の削除操作を表示中のウィンドウに登録する
import { useEffect } from "react";
import useSWR from "swr";
import type { WorktreeItem } from "../../shared/api/worktree";
import { Frame } from "../buffer/Frame";
import type { BufferController } from "../buffer/controller";
import type { ColumnDef, LineInfo } from "../buffer/line";
import type { WorktreeApi } from "../lib/worktree-api";
import type { WorktreeLocation, WorktreeSelection } from "../lib/worktree-location";
import { FileBuffer } from "./files/FileBuffer";

export const worktreeView = "worktree";
const columns: ColumnDef[] = [
  { name: "worktrees", widths: [10, 10, 0], heads: ["名前", "ブランチ", "使っているもの"] },
];
const rowId = (item: WorktreeItem) => item.id ?? "main";
const hints: [string, string][] = [
  ["open", "この worktree に切り替える"],
  ["item.delete", "消す"],
  ["right.close", "閉じる"],
];

function rowText(item: WorktreeItem) {
  const details = [
    ...(item.issue ? [`#${item.issue.number}`] : []),
    ...(item.conversations.length ? [`会話 ${item.conversations.length} 件`] : []),
    ...(!item.issue && !item.conversations.length ? ["会話なし"] : []),
    ...(item.uncommittedCount ? [`未コミット ${item.uncommittedCount}`] : []),
    ...(item.unpushedCount ? [`未 push ${item.unpushedCount}`] : []),
    ...(item.locked ? [`ロック: ${item.locked}`] : []),
    ...(item.missing ? ["フォルダがありません"] : []),
  ].join(" ");
  return [item.name, item.branch ?? "—", details];
}

export function WorktreeWindow({
  api,
  controller,
  location,
  selection,
  opening,
}: {
  api: Pick<WorktreeApi, "list" | "create" | "remove" | "switch">;
  controller: BufferController;
  location: WorktreeLocation;
  selection: WorktreeSelection;
  opening: number;
}) {
  const { projectId, source, conversationId } = location;
  const [selected, setSelected] = useState(location.worktreeId);
  const [placement, setPlacement] = useState<{ id: string }>();
  const { data, error, mutate } = useSWR(
    ["worktrees", api, projectId, opening] as const,
    ([, client, id]) => client.list(id),
  );

  const switchTo = useCallback(
    (item: WorktreeItem) => {
      if (source === "issue") {
        controller.notify("issue の作業場所は自動フローが決めます");
        return;
      }
      return (async () => {
        if (source === "conversation" && conversationId) {
          await api.switch(conversationId, item.id);
          void mutate(
            (previous) => {
              const moved = previous
                ?.flatMap((row) => row.conversations)
                .find(({ id }) => id === conversationId);
              if (!moved) return previous;
              return previous?.map((row) => {
                const others = row.conversations.filter(({ id }) => id !== conversationId);
                return { ...row, conversations: row.id === item.id ? [...others, moved] : others };
              });
            },
            { revalidate: true },
          );
        } else selection.write(projectId, item.id);
        setSelected(item.id);
        controller.notify(`worktree ${item.name} に切り替えました`);
      })();
    },
    [api, controller, conversationId, mutate, projectId, selection, source],
  );

  const create = useCallback(() => {
    let pending = false;
    controller.openPrompt({
      label: "worktree の名前",
      target: location.projectName,
      verb: "作る",
      allowChange: (text) => !/[\r\n]/.test(text),
      discardOnClose: true,
      async submit(name) {
        if (pending) return false;
        pending = true;
        try {
          const item = await api.create(projectId, name);
          setPlacement({ id: rowId(item) });
          controller.notify(`worktree ${item.name} を作りました`);
          if (item.notice) controller.notify(item.notice);
          void mutate(
            (previous) => [...(previous ?? []).filter(({ id }) => id !== item.id), item],
            {
              revalidate: true,
            },
          );
        } finally {
          pending = false;
        }
      },
      close() {},
    });
  }, [api, controller, location.projectName, mutate, projectId]);

  useEffect(() => {
    controller.setHints(worktreeView, hints);
    return controller.registerActionInterceptor("item.delete", {
      views: [worktreeView],
      run(context) {
        const current = controller.windowLines(context.window)[context.line]?.id;
        const item = data?.find((row) => rowId(row) === current);
        if (!item) return true;
        if (item.id === null) {
          controller.notify("プロジェクトのディレクトリは消せません", "error");
          return true;
        }
        const id = item.id;
        const screen = controller.screenOpening();
        const opening = controller.right.openingRevision();
        const extra =
          item.conversations.length > 0 || item.terminalId
            ? ` 会話 ${item.conversations.length} 件はプロジェクトのディレクトリで続きます。開いているターミナルは終わります`
            : "";
        controller.confirm(
          `この worktree を消しますか? (y / n)${extra}`,
          context,
          async () => {
            if (
              controller.screenOpening() !== screen ||
              controller.right.openingRevision() !== opening ||
              controller.currentLine(context.window)?.id !== id
            )
              return;
            await api.remove(id);
            if (source === "project" && selection.read(projectId) === id)
              selection.write(projectId, null);
            setSelected((currentId) => (currentId === id ? null : currentId));
            controller.notify(`worktree ${item.name} を消しました`);
            void mutate((previous) => previous?.filter((row) => row.id !== id), {
              revalidate: true,
            });
          },
          true,
        );
        return true;
      },
    });
  }, [api, controller, data, mutate, projectId, selection, source]);

  const activeRow =
    source === "project" || !conversationId
      ? undefined
      : data?.find((row) => row.conversations.some(({ id }) => id === conversationId));
  const active = activeRow ? rowId(activeRow) : (selected ?? "main");
  const lines = useMemo<LineInfo[]>(() => {
    const ordered = (data ?? []).toSorted((first, second) =>
      (first.id?.slice(0, 10) ?? "").localeCompare(second.id?.slice(0, 10) ?? ""),
    );
    const items: LineInfo[] = ordered.map((item) => {
      const cols = rowText(item);
      return {
        kind: "row",
        id: rowId(item),
        text: cols.join("  "),
        cols,
        colDef: "worktrees",
        ...(rowId(item) === active ? { mark: "●" } : {}),
        open: () => switchTo(item),
      };
    });
    if (error) items.push({ kind: "note", text: (error as Error).message });
    if (!data && !error) items.push({ kind: "skeleton", text: "読み込み中" });
    if (data)
      items.push(
        { kind: "menu", text: "worktree を作る  名前を付けて作る", open: create },
        { kind: "note", text: "● は、いま開いている会話か issue が動いている場所です。" },
        {
          kind: "note",
          text: "main はプロジェクトのディレクトリで、worktree を作らない会話はここで動きます。",
        },
      );
    return items;
  }, [active, data, error, create, switchTo]);
  return (
    <Frame title="worktree" side="right" columns={columns}>
      <FileBuffer
        side="right"
        viewName={worktreeView}
        columns={columns}
        lines={lines}
        placement={placement}
        ready={!!data || !!error}
      />
    </Frame>
  );
}
