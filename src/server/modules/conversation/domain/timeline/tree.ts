import type { TaskOp, TaskStatus } from "../../../../../shared/progress/schema";
export type { TaskOp };
export type Task = {
  id: string;
  parent: string | null;
  title: string;
  status: TaskStatus;
  weight: number;
  description?: string;
  note?: string;
  done?: [number, number];
};
type Shares = Record<TaskStatus, number>;
export type Measure = { status: TaskStatus; parts: Shares; leaves: Shares & { total: number } };
const states: TaskStatus[] = ["pending", "in_progress", "completed", "blocked"];
const emptyShares = (): Shares => ({ pending: 0, in_progress: 0, completed: 0, blocked: 0 });

function groupStatus(statuses: TaskStatus[]): TaskStatus {
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("blocked")) return "blocked";
  return statuses.includes("completed") ? "in_progress" : "pending";
}

export function measureTask(tasks: readonly Task[], id: string): Measure {
  const task = tasks.find((item) => item.id === id);
  const children = tasks.filter((item) => item.parent === id);
  const parts = emptyShares();
  const leaves = { ...emptyShares(), total: 0 };
  let status: TaskStatus = task?.status ?? "pending";
  if (children.length === 0) {
    if (task) {
      parts.completed = status === "completed" ? 1 : task.done ? task.done[0] / task.done[1] : 0;
      if (status !== "completed") parts[status] = 1 - parts.completed;
      leaves[status] = 1;
      leaves.total = 1;
    }
  } else {
    const measures = children.map((child) => measureTask(tasks, child.id));
    status = groupStatus(measures.map((value) => value.status));
    const total = children.reduce((sum, child) => sum + child.weight, 0);
    for (const [index, child] of children.entries()) {
      const value = measures[index]!;
      for (const state of states) {
        parts[state] += value.parts[state] * (child.weight / total);
        leaves[state] += value.leaves[state];
      }
      leaves.total += value.leaves.total;
    }
  }
  if (status !== "completed" && parts.completed > 0.9999) {
    const rest = parts.pending + parts.in_progress + parts.blocked;
    for (const state of states) {
      if (state !== "completed")
        parts[state] =
          rest === 0 ? (state === status ? 0.0001 : 0) : (parts[state] / rest) * 0.0001;
    }
    parts.completed = 0.9999;
  }
  return { status, parts, leaves };
}

function validDone(done: number[]): done is [number, number] {
  return done.length === 2 && done[0]! >= 0 && done[0]! <= done[1]! && done[1]! > 0;
}

export function applyOps(tasks: readonly Task[], ops: readonly TaskOp[]): Task[] {
  let next = [...tasks];
  for (const op of ops) {
    if (op.weight !== undefined && (!Number.isFinite(op.weight) || op.weight <= 0)) continue;
    if (op.done !== undefined && !validDone(op.done)) continue;
    const current = next.find((task) => task.id === op.id);
    if (
      op.op === "add"
        ? current !== undefined ||
          (op.parent !== undefined && !next.some((task) => task.id === op.parent))
        : current === undefined
    )
      continue;
    if (op.op === "remove") {
      const removed = new Set([op.id]);
      for (const task of next)
        if (task.parent !== null && removed.has(task.parent)) removed.add(task.id);
      next = next.filter((task) => !removed.has(task.id));
    } else {
      const group = next.some((task) => task.parent === op.id);
      if (
        group &&
        (op.status !== undefined || op.done !== undefined) &&
        op.title === undefined &&
        op.weight === undefined &&
        op.description === undefined &&
        op.note === undefined
      )
        continue;
      const before = current ?? {
        id: op.id,
        parent: op.parent ?? null,
        title: op.id,
        weight: 1,
        status: "pending" as const,
      };
      const units = group ? undefined : (op.done ?? before.done);
      const requested = group ? undefined : op.status;
      const status =
        requested ??
        (!group && op.done !== undefined
          ? units![0] === units![1]
            ? "completed"
            : units![0]! > 0
              ? "in_progress"
              : "pending"
          : before.status);
      if (status === "pending" && units !== undefined && units[0]! > 0) continue;
      const updated: Task = {
        ...before,
        status,
        ...(op.title === undefined ? {} : { title: op.title }),
        ...(op.weight === undefined ? {} : { weight: op.weight }),
        ...(op.description === undefined ? {} : { description: op.description }),
        ...(op.note === undefined ? {} : { note: op.note }),
      };
      delete updated.done;
      if (units !== undefined)
        updated.done = status === "completed" ? [units[1]!, units[1]!] : [units[0]!, units[1]!];
      next = current
        ? next.map((task) => (task.id === op.id ? updated : task))
        : [...next, updated];
    }
    next = next.map((task) => {
      if (!next.some((child) => child.parent === task.id)) return task;
      const updated = { ...task, status: measureTask(next, task.id).status };
      delete updated.done;
      return updated;
    });
  }
  return next;
}

export function formatProgress(completed: number): string {
  return `${(completed * 100).toFixed(2)}%`;
}
