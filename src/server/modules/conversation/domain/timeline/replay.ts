import type { Timeline, TimelineFile } from "../../../../../shared/progress/schema";
import { applyOps, measureTask, type Task } from "./tree";

export function replayTimeline(
  file: Omit<TimelineFile, "comments"> & { comments?: TimelineFile["comments"] },
): Timeline {
  let tasks: Task[] = [];
  const history: Timeline["history"] = [];
  const started = new Map<string, number>();
  for (const entry of file.journal.toSorted((a, b) => a.at - b.at)) {
    for (const op of entry.ops) {
      const before = tasks;
      tasks = applyOps(before, [op]);
      for (const task of tasks.toSorted((a, b) => (a.id === op.id ? -1 : b.id === op.id ? 1 : 0))) {
        const old = before.find((item) => item.id === task.id);
        const was = measureTask(before, task.id);
        const now = measureTask(tasks, task.id);
        const changed = old !== task;
        if (
          task.id === op.id
            ? !changed
            : old === undefined ||
              (was.status === now.status && was.parts.completed === now.parts.completed)
        )
          continue;
        if (old === undefined) started.set(task.id, entry.at);
        history.push({
          at: entry.at,
          taskId: task.id,
          title: task.title,
          from: old?.status ?? null,
          to: now.status,
          weight: task.weight,
          completedBefore: was.parts.completed,
          completedAfter: now.parts.completed,
          description: task.id === op.id ? (op.description ?? null) : null,
          note: task.id === op.id ? (op.note ?? null) : null,
          agentId: entry.agentId ?? null,
        });
      }
    }
  }
  const ordered: Task[] = [];
  const visit = (parent: string | null): void => {
    for (const task of tasks.filter((item) => item.parent === parent)) {
      ordered.push(task);
      visit(task.id);
    }
  };
  visit(null);
  const trees = tasks
    .filter((task) => task.parent === null)
    .map((task) => {
      const measure = measureTask(tasks, task.id);
      return {
        id: task.id,
        title: task.title,
        ...measure,
        completed: measure.parts.completed,
        startedAt: started.get(task.id) || null,
      };
    });
  return {
    defaultTreeId:
      trees.find((tree) => tree.leaves.in_progress > 0)?.id ?? trees.at(-1)?.id ?? null,
    trees,
    tasks: ordered.map((task) => {
      const measure = measureTask(tasks, task.id);
      const group = tasks.some((child) => child.parent === task.id);
      const units = group
        ? [measure.leaves.completed, measure.leaves.total]
        : (task.done ?? [task.status === "completed" ? 1 : 0, 1]);
      return { ...task, completed: measure.parts.completed, units: `${units[0]} / ${units[1]}` };
    }),
    history: history.reverse(),
    reports: file.reports.toSorted((a, b) => b.at - a.at),
    comments: (file.comments ?? []).toSorted((a, b) => a.at - b.at),
  };
}
