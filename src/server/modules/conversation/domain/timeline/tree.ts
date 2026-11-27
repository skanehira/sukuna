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

function measure(
  task: Task | undefined,
  children: readonly Task[],
  measured: ReadonlyMap<string, Measure>,
): Measure {
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
    const measures = children.map((child) => measured.get(child.id)!);
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
  return capMeasure({ status, parts, leaves });
}
function capMeasure(value: Measure): Measure {
  const { status, parts, leaves } = value;
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

export function measureTasks(tasks: readonly Task[]): Map<string, Measure> {
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parent === null) continue;
    const siblings = children.get(task.parent) ?? [];
    siblings.push(task);
    children.set(task.parent, siblings);
  }
  const measured = new Map<string, Measure>();
  const stack = tasks.toReversed().map((task) => ({ task, visited: false }));
  while (stack.length) {
    const { task, visited } = stack.pop()!;
    if (measured.has(task.id)) continue;
    const descendants = children.get(task.id) ?? [];
    if (visited || descendants.length === 0) {
      measured.set(task.id, measure(task, descendants, measured));
    } else {
      stack.push({ task, visited: true });
      for (let index = descendants.length - 1; index >= 0; index--)
        stack.push({ task: descendants[index]!, visited: false });
    }
  }
  return measured;
}

export function measureTask(tasks: readonly Task[], id: string): Measure {
  return measureTasks(tasks).get(id) ?? measure(undefined, [], new Map());
}

function validDone(done: number[]): done is [number, number] {
  return done.length === 2 && done[0]! >= 0 && done[0]! <= done[1]! && done[1]! > 0;
}

type Aggregate = {
  weight: number;
  parts: Shares;
  leaves: Shares & { total: number };
  statuses: Shares;
};
type SumNode = { left?: SumNode; right?: SumNode; sum: Aggregate };
const emptyAggregate = (): Aggregate => ({
  weight: 0,
  parts: emptyShares(),
  leaves: { ...emptyShares(), total: 0 },
  statuses: emptyShares(),
});
function combine(left: Aggregate, right: Aggregate): Aggregate {
  const sum = emptyAggregate();
  sum.weight = left.weight + right.weight;
  sum.leaves.total = left.leaves.total + right.leaves.total;
  for (const state of states) {
    sum.parts[state] = left.parts[state] + right.parts[state];
    sum.leaves[state] = left.leaves[state] + right.leaves[state];
    sum.statuses[state] = left.statuses[state] + right.statuses[state];
  }
  return sum;
}
class ChildIndex {
  revision = 0;
  readonly items = new Map<string, Task>();
  private positions = new Map<string, number>();
  private capacity = 1;
  private root?: SumNode;
  set(id: string, task: Task | undefined, value?: Measure): void {
    this.revision++;
    let position = this.positions.get(id);
    if (position === undefined) {
      position = this.positions.size;
      this.positions.set(id, position);
    }
    while (position >= this.capacity) {
      this.root = { left: this.root, sum: this.root?.sum ?? emptyAggregate() };
      this.capacity *= 2;
    }
    let contribution: Aggregate | undefined;
    if (task && value) {
      this.items.set(id, task);
      contribution = emptyAggregate();
      contribution.weight = task.weight;
      contribution.leaves = value.leaves;
      contribution.statuses[value.status] = 1;
      for (const state of states) contribution.parts[state] = value.parts[state] * task.weight;
    } else this.items.delete(id);
    const update = (node: SumNode | undefined, start: number, end: number): SumNode | undefined => {
      if (end - start === 1) return contribution ? { sum: contribution } : undefined;
      const middle = (start + end) / 2;
      const left = position < middle ? update(node?.left, start, middle) : node?.left;
      const right = position >= middle ? update(node?.right, middle, end) : node?.right;
      return left || right
        ? {
            left,
            right,
            sum: combine(left?.sum ?? emptyAggregate(), right?.sum ?? emptyAggregate()),
          }
        : undefined;
    };
    this.root = update(this.root, 0, this.capacity);
  }
  measure(task: Task): Measure {
    if (!this.items.size) return measure(task, [], new Map());
    const sum = this.root!.sum;
    const status: TaskStatus =
      sum.statuses.completed === this.items.size
        ? "completed"
        : sum.statuses.in_progress > 0
          ? "in_progress"
          : sum.statuses.blocked > 0
            ? "blocked"
            : sum.statuses.completed > 0
              ? "in_progress"
              : "pending";
    const parts = emptyShares();
    for (const state of states)
      parts[state] = sum.weight === Infinity ? 0 : sum.parts[state] / sum.weight;
    return capMeasure({ status, parts, leaves: { ...sum.leaves } });
  }
}

type IndexedTask = {
  task: Task;
  measure: Measure;
  children: ChildIndex;
  order: number;
  exact?: { revision: number; measure: Measure };
};
export type TaskChange = { task: Task; now: Measure; before?: Task; was?: Measure; order: number };
function sameMeasure(a: Measure, b: Measure): boolean {
  return (
    a.status === b.status &&
    a.leaves.total === b.leaves.total &&
    states.every(
      (state) => a.parts[state] === b.parts[state] && a.leaves[state] === b.leaves[state],
    )
  );
}
function updateTask(current: Task | undefined, op: TaskOp, group: boolean): Task | null {
  if (
    group &&
    (op.status !== undefined || op.done !== undefined) &&
    op.title === undefined &&
    op.weight === undefined &&
    op.description === undefined &&
    op.note === undefined
  )
    return null;
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
  if (status === "pending" && units !== undefined && units[0]! > 0) return null;
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

  return updated;
}
export class TaskTree {
  private nodes = new Map<string, IndexedTask>();
  private order = 0;
  constructor(tasks: readonly Task[] = []) {
    const measured = measureTasks(tasks);
    for (const task of tasks)
      this.nodes.set(task.id, {
        task,
        measure: measured.get(task.id)!,
        children: new ChildIndex(),
        order: this.order++,
      });
    for (const task of tasks) {
      const node = this.nodes.get(task.id)!;
      if (task.parent !== null)
        this.nodes.get(task.parent)?.children.set(task.id, task, node.measure);
    }
  }
  tasks(): Task[] {
    return [...this.nodes.values()].map((node) => node.task);
  }
  measure(id: string): Measure {
    return this.nodes.get(id)!.measure;
  }
  private calculate(node: IndexedTask, task: Task): Measure {
    const value = node.children.measure(task);
    const rounded = value.parts.completed * 10000;
    if (node.children.items.size && Math.abs(rounded - Math.floor(rounded) - 0.5) < 0.000001) {
      if (node.exact?.revision === node.children.revision) return node.exact.measure;
      const tasks = [task];
      const pending = [...node.children.items.values()].toReversed();
      while (pending.length) {
        const child = pending.pop()!;
        tasks.push(child);
        for (const descendant of [
          ...this.nodes.get(child.id)!.children.items.values(),
        ].toReversed())
          pending.push(descendant);
      }
      const exact = measureTasks(tasks).get(task.id)!;
      node.exact = { revision: node.children.revision, measure: exact };
      return exact;
    }
    return value;
  }
  apply(op: TaskOp): TaskChange[] {
    if (op.weight !== undefined && (!Number.isFinite(op.weight) || op.weight <= 0)) return [];
    if (op.done !== undefined && !validDone(op.done)) return [];
    const current = this.nodes.get(op.id);
    if (
      op.op === "add"
        ? current !== undefined || (op.parent !== undefined && !this.nodes.has(op.parent))
        : current === undefined
    )
      return [];
    const changes: TaskChange[] = [];
    let task: Task | undefined;
    let value: Measure | undefined;
    let parent: string | null;
    if (op.op === "remove") {
      parent = current!.task.parent;
      const pending = [current!];
      while (pending.length) {
        const node = pending.pop()!;
        for (const child of node.children.items.values()) pending.push(this.nodes.get(child.id)!);
        this.nodes.delete(node.task.id);
      }
    } else {
      task = updateTask(current?.task, op, (current?.children.items.size ?? 0) > 0) ?? undefined;
      if (!task) return [];
      const node: IndexedTask = current ?? {
        task,
        measure: measure(undefined, [], new Map()),
        children: new ChildIndex(),
        order: this.order++,
      };
      const before = current?.task;
      const was = current?.measure;
      value = this.calculate(node, task);
      if (node.children.items.size) {
        task.status = value.status;
        delete task.done;
      }
      node.task = task;
      node.measure = value;
      this.nodes.set(task.id, node);
      changes.push({ task, now: value, before, was, order: node.order });
      parent = task.parent;
      if (before && before.weight === task.weight && was && sameMeasure(was, value)) return changes;
    }
    let childId = op.id;
    while (parent !== null) {
      const node = this.nodes.get(parent)!;
      const before = node.task;
      const was = node.measure;
      node.children.set(childId, task, value);
      value = this.calculate(node, before);
      task = { ...before };
      if (node.children.items.size) {
        task.status = value.status;
        delete task.done;
      }
      node.task = task;
      node.measure = value;
      if (was.status !== value.status || was.parts.completed !== value.parts.completed)
        changes.push({ task, now: value, before, was, order: node.order });
      if (sameMeasure(was, value)) break;
      childId = parent;
      parent = task.parent;
    }
    return changes.toSorted((a, b) =>
      a.task.id === op.id ? -1 : b.task.id === op.id ? 1 : a.order - b.order,
    );
  }
}
export function applyOps(tasks: readonly Task[], ops: readonly TaskOp[]): Task[] {
  const tree = new TaskTree(tasks);
  for (const op of ops) tree.apply(op);
  return tree.tasks();
}

export function formatProgress(completed: number): string {
  return `${(completed * 100).toFixed(2)}%`;
}
