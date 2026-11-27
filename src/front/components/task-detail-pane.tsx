import { LifecycleBuffer } from "./lifecycle/LifecycleBuffer";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import type { Timeline } from "../../shared/progress/schema";
import {
  historyTime,
  percent,
  reportTime,
  taskStates,
  textLines,
  timelineFailure,
  timelineHeading,
  timelineNote,
} from "../lib/timeline-lines";
import { timelineField } from "./timeline-pane";

const columns: ColumnDef[] = [
  { name: "timeline-field", widths: [7, 13], wrap: [false, true] },
  { name: "timeline-action", widths: [1.4, 16, 0] },
];

export function taskDetailLines(
  data: Timeline | null,
  taskId: string | null,
  readError: boolean,
  now: Date,
): LineInfo[] {
  const rows: LineInfo[] = readError ? [timelineNote(timelineFailure)] : [];
  if (!data && readError) return rows;
  const task = data?.tasks.find(({ id }) => id === taskId);
  if (!data || !task)
    return [...rows, timelineNote("タスクが見つかりません。タイムラインから選び直してください。")];
  const parents = new Map(data.tasks.map(({ id, parent }) => [id, parent]));
  let root = task.id;
  const seen = new Set<string>();
  for (
    let parent = parents.get(root);
    parent != null && !seen.has(parent);
    parent = parents.get(root)
  ) {
    seen.add(root);
    root = parent;
  }
  const tree = data.trees.find(({ id }) => id === root);
  rows.push(
    ...timelineField("タスク", task.title),
    ...timelineField("状態", taskStates[task.status].label),
    ...timelineField("木", tree?.title ?? "—"),
    ...timelineField("進み", percent(task.completed)),
    ...timelineField("重み", String(task.weight)),
    ...timelineField("完了した単位", task.units),
    ...timelineField("説明", task.description || "—"),
    ...timelineField("メモ", task.note || "—"),
    timelineHeading("コメント"),
  );
  const comments = data.comments.filter((comment) => comment.taskId === task.id);
  if (!comments.length) rows.push(timelineNote("コメントはありません"));
  else
    for (const comment of comments)
      rows.push(...textLines(comment.text, `${reportTime(comment.at, now)}  あなた: `));
  rows.push(timelineHeading("履歴"));
  for (const change of data.history) {
    if (change.taskId !== task.id) continue;
    rows.push(
      ...textLines(
        [
          historyTime(change.at),
          taskStates[change.to].label,
          `${percent(change.completedBefore)} → ${percent(change.completedAfter)}`,
          `重み ${change.weight}`,
          change.description,
          change.note,
          change.agentId,
        ]
          .filter((part) => part !== null && part !== "")
          .join("  "),
      ),
    );
  }
  rows.push({
    kind: "menu",
    text: "このタスクについて相談する",
    action: "timeline.consult",
    colDef: "timeline-action",
  });
  return rows;
}

export function TaskDetailPane({ posKey, lines }: { posKey: string; lines: LineInfo[] | null }) {
  return (
    <Frame title="タスクの詳細" side="right">
      {lines ? (
        <LifecycleBuffer
          side="right"
          viewName="timeline-task"
          posKey={posKey}
          columns={columns}
          lines={lines}
        />
      ) : (
        <p className="px-4 py-2 text-[13px] text-muted" role="status">
          読み込み中
        </p>
      )}
    </Frame>
  );
}
