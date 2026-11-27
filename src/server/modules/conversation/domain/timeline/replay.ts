import type { Timeline, TimelineFile } from "../../../../../shared/progress/schema";
import { TaskTree, type Task } from "./tree";

export function replayTimeline(
  file: Omit<TimelineFile, "comments"> & { comments?: TimelineFile["comments"] },
): Timeline {
  const tree = new TaskTree();
  const history: Timeline["history"] = [];
  const started = new Map<string, number>();
  for (const entry of file.journal.toSorted((a, b) => a.at - b.at)) {
    for (const op of entry.ops) {
      for (const { task, before: old, was, now } of tree.apply(op)) {
        if (old === undefined) started.set(task.id, entry.at);
        history.push({
          at: entry.at,
          taskId: task.id,
          title: task.title,
          from: old?.status ?? null,
          to: now.status,
          weight: task.weight,
          completedBefore: was?.parts.completed ?? 0,
          completedAfter: now.parts.completed,
          description: task.id === op.id ? (op.description ?? null) : null,
          note: task.id === op.id ? (op.note ?? null) : null,
          agentId: entry.agentId ?? null,
        });
      }
    }
  }
  const tasks = tree.tasks();
  const ordered: Task[] = [];
  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const siblings = children.get(task.parent) ?? [];
    siblings.push(task);
    children.set(task.parent, siblings);
  }
  const pending = (children.get(null) ?? []).toReversed();
  while (pending.length) {
    const task = pending.pop()!;
    ordered.push(task);
    pending.push(...(children.get(task.id) ?? []).toReversed());
  }
  const trees = tasks
    .filter((task) => task.parent === null)
    .map((task) => {
      const measure = tree.measure(task.id);
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
      trees.find((tree) => tree.status === "in_progress")?.id ?? trees.at(-1)?.id ?? null,
    trees,
    tasks: ordered.map((task) => {
      const measure = tree.measure(task.id);
      const group = children.has(task.id);
      const units = group
        ? [measure.leaves.completed, measure.leaves.total]
        : (task.done ?? [task.status === "completed" ? 1 : 0, 1]);
      return { ...task, completed: measure.parts.completed, units: `${units[0]} / ${units[1]}` };
    }),
    history: history.reverse(),
    reports: file.reports.toSorted((a, b) => b.at - a.at),
    comments: (file.comments ?? []).toSorted((a, b) => a.at - b.at),
    unresolvedComments: [],
  };
}
