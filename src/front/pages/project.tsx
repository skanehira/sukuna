import { useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: プロジェクトのキー操作を登録し、画面を離れたら解除する
import { useEffect } from "react";
import type { OverviewResponse } from "../../shared/inbox/schema";
import type { IssueState } from "../../shared/issue/state";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { ListingBuffer } from "../components/listing-buffer";
import type { InboxStore } from "../lib/inbox-store";
import { Skeleton } from "../shell/loading";
import { WindowError } from "../shell/ShellBoundary";
import { activityStatus, listingRow } from "./inbox";

const sections: [IssueState, string][] = [
  ["stopped", "停止中"],
  ["design_review", "設計レビュー"],
  ["implementing", "実装中"],
  ["design", "設計待ち"],
  ["triage", "精査待ち"],
  ["ready", "実装待ち"],
  ["draft", "下書き"],
  ["done", "完了"],
  ["withdrawn", "取り下げ"],
];
const columns: ColumnDef[] = [
  {
    name: "project",
    widths: [28, 26, 5],
    heads: ["題名", "状況", "経過"],
    classes: ["", "text-muted text-[13px]", "text-muted text-[12px]"],
    align: ["left", "left", "right"],
  },
];
type Withdraw = (id: string) => Promise<{ stoppedDependents: number[] }>;
function projectLines(data: OverviewResponse, now: number, store: InboxStore): LineInfo[] {
  const lines: LineInfo[] = [];
  for (const [state, label] of sections) {
    const section = data.issueSections.find((section) => section.state === state);
    if (!section || section.total === 0) continue;
    const closed = state === "done" || state === "withdrawn";
    const rows =
      closed && !store.isExpanded(data.project.id, state)
        ? section.rows.slice(0, 10)
        : section.rows;
    lines.push({ kind: "section", text: `${label}  ${section.total}` });
    lines.push(
      ...rows.map((row) =>
        listingRow(
          row.key,
          `#${row.number} ${row.title}`,
          activityStatus(row, now),
          row.lastActivityAt,
          row.unread,
          now,
          `/issues/${encodeURIComponent(row.id)}${state === "draft" ? "/edit" : row.activity ? "?tail=1" : ""}`,
        ),
      ),
    );
    if (section.total > rows.length)
      lines.push({
        kind: "menu",
        text: `ほか ${section.total - rows.length} 件を表示する`,
        id: `expand:${state}`,
        action: `project.expand.${state}`,
      });
  }
  if (data.conversations.length) {
    lines.push({ kind: "section", text: `会話  ${data.conversations.length}` });
    lines.push(
      ...data.conversations.map((row) =>
        listingRow(
          row.key,
          `会話: ${row.title || "(題名なし)"}`,
          activityStatus(row, now),
          row.lastActivityAt,
          row.unread,
          now,
          `/conversations/${encodeURIComponent(row.id)}${row.activity ? "?tail=1" : ""}`,
        ),
      ),
    );
  }
  return lines.length
    ? lines
    : [{ kind: "note", text: "issue はまだありません。Space o で作ります。" }];
}
export function ProjectPage({
  store,
  id,
  controller,
  withdraw,
  onProjectShown,
}: {
  store: InboxStore;
  id: string;
  controller: BufferController;
  withdraw: Withdraw;
  onProjectShown?: (id: string) => void;
}) {
  const resource = store.overview(id);
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot);
  const data = state.data;
  useEffect(() => {
    if (data) onProjectShown?.(data.project.id);
    const rows = data?.issueSections.flatMap((section) => section.rows) ?? [];
    const current = () => rows.find((row) => row.key === controller.currentLine()?.id);
    const removers = [
      ...["done", "withdrawn"].map((closedState) =>
        controller.actions.register({
          name: `project.expand.${closedState}`,
          label: "残りを表示する",
          group: "そのほか",
          where: "プロジェクト",
          views: ["project"],
          run: () => store.expandClosed(id, closedState),
        }),
      ),
      controller.actions.register({
        name: "item.edit",
        label: "issue を編集する",
        group: "そのほか",
        where: "プロジェクト",
        views: ["project"],
        run: () => {
          const row = current();
          if (row) return controller.navigate(`/issues/${encodeURIComponent(row.id)}/edit`);
        },
      }),
      controller.actions.register({
        name: "item.delete",
        label: "issue を取り下げる",
        group: "そのほか",
        where: "プロジェクト",
        views: ["project"],
        run: () => {
          const row = current();
          if (row) return controller.run(`project.withdraw.${row.id}`);
        },
      }),
      ...(data?.issueSections
        .filter((section) => section.state !== "done" && section.state !== "withdrawn")
        .flatMap((section) =>
          section.rows.map((row) =>
            controller.actions.register({
              name: `project.withdraw.${row.id}`,
              label: "issue を取り下げる",
              group: "そのほか",
              where: "プロジェクト",
              views: ["project"],
              confirm: `#${row.number} ${row.title} を取り下げて閉じますか?`,
              run: async () => {
                const result = await withdraw(row.id);
                controller.notify(
                  `issue を取り下げて閉じました${result.stoppedDependents.length ? `。依存する ${result.stoppedDependents.map((number) => `#${number}`).join("、")} を停止中にしました` : ""}`,
                );
                await store.reload();
              },
            }),
          ),
        ) ?? []),
    ];
    controller.setHints("project", [
      ["open", "開く"],
      ["item.edit", "編集"],
      ["item.delete", "取り下げ"],
    ]);
    return () => {
      removers.forEach((remove) => remove());
      controller.setHints("project", []);
    };
  }, [data, store, id, controller, withdraw, onProjectShown]);
  const missing = state.error?.code === "not_found";
  return (
    <Frame
      title={missing ? "見つかりません" : (data?.project.name ?? "プロジェクト")}
      side="table"
      active
      columns={columns}
    >
      {state.loading && !data ? (
        <Skeleton side="main" />
      ) : missing ? null : (
        <ListingBuffer
          side="table"
          viewName="project"
          posKey={`/projects/${id}:main:project`}
          lines={data ? projectLines(data, state.now, store) : []}
          columns={columns}
        />
      )}
      {state.error ? (
        <WindowError
          message={state.error.message}
          onHome={() => {
            void controller.navigate("/");
          }}
          onReload={() => {
            void resource.load();
          }}
        />
      ) : null}
    </Frame>
  );
}
