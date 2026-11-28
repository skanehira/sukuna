import type { TaskStatus, Timeline } from "../../shared/progress/schema";
import type { LineInfo } from "../buffer/line";

export const taskStates: Record<
  TaskStatus,
  { label: string; mark: string; tone: NonNullable<LineInfo["tone"]> }
> = {
  pending: { label: "未着手", mark: "○", tone: "muted" },
  in_progress: { label: "進行中", mark: "◐", tone: "doing" },
  completed: { label: "完了", mark: "●", tone: "done" },
  blocked: { label: "停止", mark: "✕", tone: "wait" },
};
export const timelineFailure =
  "タイムラインのファイルを読めませんでした。前に読めた内容を出しています。";

export const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
export const timelineNote = (text: string): LineInfo => ({ kind: "note", text });
export const timelineHeading = (text: string): LineInfo => ({ kind: "heading", text });

export function textLines(text: string, prefix = ""): LineInfo[] {
  return text.split(/\r\n?|\n/).map((line, index) => ({
    kind: "text",
    text: index === 0 ? prefix + line : line,
  }));
}

export function taskRows(
  data: Timeline,
  treeId: string,
): { task: Timeline["tasks"][number]; depth: number }[] {
  const levels = new Map<string, number>([[treeId, 0]]);
  return data.tasks.flatMap((task) => {
    if (task.id === treeId) return [{ task, depth: 0 }];
    if (task.parent === null) return [];
    const parent = levels.get(task.parent);
    if (parent === undefined) return [];
    const depth = parent + 1;
    levels.set(task.id, depth);
    return [{ task, depth }];
  });
}

function digits(value: number): string {
  return String(value).padStart(2, "0");
}

function day(date: Date): string {
  return `${digits(date.getMonth() + 1)}/${digits(date.getDate())}`;
}

function time(date: Date): string {
  return `${digits(date.getHours())}:${digits(date.getMinutes())}`;
}

export function reportTime(at: number, now: Date): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toDateString() === now.toDateString() ? time(date) : `${day(date)} ${time(date)}`;
}

export function historyTime(at: number): string {
  const date = new Date(at);
  if (!at || !Number.isFinite(date.getTime())) return "—";
  return `${date.getFullYear()}/${day(date)} ${time(date)}:${digits(date.getSeconds())}`;
}
