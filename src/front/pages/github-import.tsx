import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- バッファの選択操作を表示している間だけ登録する
import { useEffect } from "react";
import useSWR from "swr";
import type { GithubImportResponse, GithubIssuesResponse } from "../../shared/api/github-import";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import type { ActionInfo } from "../buffer/keymap/registry";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { LifecycleBuffer } from "../components/lifecycle/LifecycleBuffer";

export const githubImportTitle = "GitHub の issue の取り込み";
const action = "github-import.selected";
const menu = "選んだ issue を下書きとして取り込む";
export const githubImportAction = {
  name: action,
  label: menu,
  group: "そのほか",
  where: githubImportTitle,
  views: ["github-import"],
} satisfies ActionInfo;
const columns: ColumnDef[] = [
  {
    name: "github-issues",
    heads: ["番号と題名", "ラベル", "作った日", "取り込み"],
    widths: [33, 19, 9, 14],
  },
];

type GithubImportApi = {
  candidates(id: string): Promise<GithubIssuesResponse>;
  importIssues(id: string, numbers: number[]): Promise<GithubImportResponse>;
};

const skipLabels = {
  already_imported: "取り込み済みの",
  not_open: "閉じた",
  not_found: "見つからなかった",
  too_long: "上限を超えた",
} satisfies Record<GithubImportResponse["skipped"][number]["reason"], string>;

function resultMessage({ imported, skipped }: GithubImportResponse): string {
  const reasons = Object.entries(skipLabels).flatMap(([reason, label]) => {
    const count = skipped.filter((entry) => entry.reason === reason).length;
    return count === 0 ? [] : [`${label} ${count} 件`];
  });
  const base = `${imported.length} 件を下書きとして取り込みました`;
  return reasons.length === 0 ? base : `${base} (${reasons.join("と")}は飛ばしました)`;
}

export function GithubImportPage({
  controller,
  projectId,
  api,
  formatDate,
}: {
  controller: BufferController;
  projectId: string;
  api: GithubImportApi;
  formatDate: (at: number) => string;
}) {
  const { data, error, mutate } = useSWR(
    ["github-issues", projectId, api],
    () => api.candidates(projectId),
    {
      revalidateOnMount: true,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      dedupingInterval: 0,
    },
  );
  const busy = useRef(false);
  useEffect(
    () =>
      controller.actions.register({
        ...githubImportAction,
        async run(context) {
          if (busy.current || !data) return;
          const lines = context.selectedLines ?? [controller.currentLine(context.window)];
          const selected = lines.flatMap((line) =>
            line?.colDef === "github-issues" && line.id !== undefined ? [Number(line.id)] : [],
          );
          if (selected.length === 0) {
            controller.notify("取り込む issue の行を選んでください。");
            return;
          }
          if (selected.length > 100) {
            controller.notify("一度に取り込める issue は100件までです。", "error");
            return;
          }
          busy.current = true;
          try {
            const result = await api.importIssues(projectId, selected);
            controller.notify(resultMessage(result));
            await mutate();
          } finally {
            busy.current = false;
          }
        },
      }),
    [api, controller, data, mutate, projectId],
  );

  const lines: LineInfo[] = [];
  if (error)
    lines.push({
      kind: "note",
      text: error instanceof Error ? error.message : "GitHub の issue を読み込めませんでした。",
    });
  else if (!data) lines.push({ kind: "skeleton", text: "読み込み中" });
  else if (data.issues.length === 0)
    lines.push({ kind: "note", text: "open の issue はありません" });
  else {
    if (data.truncated) lines.push({ kind: "note", text: "新しい 200 件だけを並べています" });
    for (const row of data.issues) {
      const cols = [
        `#${row.number} ${row.title.replace(/[\r\n]/g, " ")}`,
        row.labels.join(" ").replace(/[\r\n]/g, " "),
        formatDate(row.createdAt),
        row.imported ? "取り込み済み" : "",
      ];
      lines.push({
        id: String(row.number),
        kind: "row",
        colDef: "github-issues",
        action,
        text: cols.join("  "),
        cols,
        tone: row.imported ? "muted" : undefined,
      });
    }
    lines.push({ kind: "menu", id: action, text: menu, action });
  }
  return (
    <Frame title={githubImportTitle} side="main" columns={columns}>
      <LifecycleBuffer side="main" viewName="github-import" columns={columns} lines={lines} />
    </Frame>
  );
}
