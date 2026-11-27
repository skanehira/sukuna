import { Buffer, type BufferHandle } from "../buffer/Buffer";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { formatStageElapsed } from "../../shared/activity/stage";
import type { Timeline } from "../../shared/progress/schema";
import {
  percent,
  reportTime,
  taskRows,
  taskStates,
  textLines,
  timelineFailure,
  timelineHeading,
  timelineNote,
} from "../lib/timeline-lines";

const columns: ColumnDef[] = [
  { name: "timeline-task", widths: [11, 3.5, 5], align: ["left", "left", "right"] },
  { name: "timeline-field", widths: [5, 0] },
];
const statusOrder = ["completed", "in_progress", "blocked", "pending"] as const;

export function selectedTree(data: Timeline | null, selected: string | null) {
  if (!data) return null;
  return (
    data.trees.find((tree) => tree.id === selected) ??
    data.trees.find((tree) => tree.id === data.defaultTreeId) ??
    data.trees.at(-1) ??
    null
  );
}

export function nextTree(
  data: Timeline,
  selected: string | null,
  direction: -1 | 1,
): string | null {
  const tree = selectedTree(data, selected);
  if (!tree) return null;
  const position = data.trees.indexOf(tree);
  return data.trees[position + direction]?.id ?? tree.id;
}

export function timelineField(label: string, value: string): LineInfo[] {
  const [first, ...rest] = textLines(value);
  const cols = [label, first.text];
  return [{ kind: "pair", text: cols.join("  "), cols, colDef: "timeline-field" }, ...rest];
}

export function timelineLines(
  data: Timeline | null,
  selected: string | null,
  readError: boolean,
  now: Date,
): LineInfo[] {
  const rows: LineInfo[] = readError ? [timelineNote(timelineFailure)] : [];
  if (!data && readError) return rows;
  const tree = selectedTree(data, selected);
  if (data && tree) {
    const position = data.trees.indexOf(tree) + 1;
    rows.push(
      ...timelineField("木", `${position} / ${data.trees.length}  ${tree.title}`),
      ...timelineField("状態", taskStates[tree.status].label),
      ...timelineField(
        "進み",
        `${percent(tree.completed)}  (末端のタスク ${tree.leaves.completed} / ${tree.leaves.total})`,
      ),
      ...timelineField(
        "内訳",
        statusOrder
          .filter((status) => tree.leaves[status] > 0)
          .map((status) => `${taskStates[status].label} ${tree.leaves[status]}`)
          .join(" · "),
      ),
      ...timelineField(
        "経過",
        tree.startedAt === null
          ? "—"
          : formatStageElapsed(tree.startedAt, { now: () => now.getTime() }),
      ),
      { kind: "separator", text: "", progress: statusOrder.map((status) => tree.parts[status]) },
      {
        kind: "colhead",
        text: "タスク  状態  進み",
        cols: ["タスク", "状態", "進み"],
        colDef: "timeline-task",
      },
    );
    for (const { task, depth } of taskRows(data, tree.id)) {
      const state = taskStates[task.status];
      const [first, ...rest] = textLines(task.title);
      const cols = [
        `${"    ".repeat(depth)}${state.mark} ${first.text}`,
        state.label,
        percent(task.completed),
      ];
      rows.push(
        {
          kind: "row",
          text: cols.join("  "),
          cols,
          colDef: "timeline-task",
          id: task.id,
          action: "timeline.task",
          tone: state.tone,
        },
        ...rest,
      );
    }
  } else {
    rows.push(timelineNote("タスクの木はまだありません。AI が計画を立てると、ここに出ます。"));
  }
  rows.push(timelineHeading("報告 (3 分ごと)"));
  if (!data?.reports.length) rows.push(timelineNote("報告はまだありません"));
  else
    for (const report of data.reports)
      rows.push(timelineNote(reportTime(report.at, now)), ...textLines(report.text));
  if (tree) rows.push({ kind: "menu", text: "続きを依頼する", action: "timeline.continue" });
  return rows;
}

export function TimelinePane({
  posKey,
  lines,
  onReady,
}: {
  posKey: string;
  lines: LineInfo[] | null;
  onReady: (handle: BufferHandle) => void;
}) {
  return (
    <Frame title="タイムライン" side="right">
      {lines ? (
        <Buffer
          side="right"
          viewName="timeline"
          posKey={posKey}
          columns={columns}
          lines={lines}
          onReady={onReady}
        />
      ) : (
        <p className="px-4 py-2 text-[13px] text-muted" role="status">
          読み込み中
        </p>
      )}
    </Frame>
  );
}
