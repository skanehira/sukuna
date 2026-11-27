import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { applyOps, formatProgress, measureTask, TaskTree, type Task } from "./tree";

const units = fc
  .integer({ min: 1, max: 100 })
  .chain((total) =>
    fc.record({ total: fc.constant(total), done: fc.integer({ min: 0, max: total }) }),
  );
const leaf = fc.record({
  weight: fc.integer({ min: 1, max: 100 }),
  status: fc.constantFrom(
    "pending" as const,
    "in_progress" as const,
    "completed" as const,
    "blocked" as const,
  ),
  units,
});

test.prop([units, fc.string()])(
  "単位を指定した追加は題名と単位由来の状態を持つタスクになる",
  ({ done, total }, title) => {
    expect(applyOps([], [{ op: "add", id: "task", title, done: [done, total] }])).toEqual([
      {
        id: "task",
        parent: null,
        title,
        weight: 1,
        status: done === 0 ? "pending" : done === total ? "completed" : "in_progress",
        done: [done, total],
      },
    ]);
  },
);

test.prop([fc.array(leaf, { minLength: 1, maxLength: 16 })])(
  "葉の重みと単位を親の進捗と末端数へ反映する",
  (leaves) => {
    const tree = new TaskTree();
    tree.apply({ op: "add", id: "root" });
    for (const [index, item] of leaves.entries())
      tree.apply({
        op: "add",
        id: `leaf${index}`,
        parent: "root",
        weight: item.weight,
        status: item.status,
        done: [item.status === "pending" ? 0 : item.units.done, item.units.total],
      });
    const statuses = leaves.map((item) => item.status);
    const status = statuses.every((value) => value === "completed")
      ? "completed"
      : statuses.includes("in_progress")
        ? "in_progress"
        : statuses.includes("blocked")
          ? "blocked"
          : statuses.includes("completed")
            ? "in_progress"
            : "pending";
    const weight = leaves.reduce((sum, item) => sum + item.weight, 0);
    const fraction = leaves.reduce(
      (sum, item) =>
        sum +
        (item.status === "completed"
          ? 1
          : item.status === "pending"
            ? 0
            : Math.min(0.9999, item.units.done / item.units.total)) *
          (item.weight / weight),
      0,
    );
    const counts = { total: leaves.length, pending: 0, in_progress: 0, completed: 0, blocked: 0 };
    for (const value of statuses) counts[value]++;
    const measured = tree.measure("root");
    expect({
      count: tree.tasks().length,
      status: measured.status,
      leaves: measured.leaves,
      progress: formatProgress(measured.parts.completed),
    }).toEqual({
      count: leaves.length + 1,
      status,
      leaves: counts,
      progress: `${((status === "completed" ? fraction : Math.min(0.9999, fraction)) * 100).toFixed(2)}%`,
    });
  },
);

test.prop([fc.integer({ min: 1, max: 30 }), fc.string()])(
  "親を削除すると子孫を消し別の木を残す",
  (count, title) => {
    const root: Task = { id: "root", title, parent: null, weight: 1, status: "pending" };
    const other: Task = {
      id: "other",
      title: "別の木",
      parent: null,
      weight: 1,
      status: "pending",
    };
    const tasks = [
      root,
      ...Array.from({ length: count }, (_, index) => ({
        ...root,
        id: `child${index}`,
        parent: index === 0 ? "root" : `child${index - 1}`,
      })),
      other,
    ];
    const remaining = applyOps(tasks, [{ op: "remove", id: "root" }]);
    expect({ tasks: remaining, measure: measureTask(remaining, "other") }).toEqual({
      tasks: [other],
      measure: {
        status: "pending",
        parts: { pending: 1, in_progress: 0, completed: 0, blocked: 0 },
        leaves: { total: 1, pending: 1, in_progress: 0, completed: 0, blocked: 0 },
      },
    });
  },
);

test.prop([fc.array(leaf, { minLength: 2, maxLength: 16 })])(
  "初期化した木でも葉の状態と重みを集計し、その後の更新を全祖先へ伝える",
  (leaves) => {
    const tasks: Task[] = [
      { id: "root", parent: null, title: "木", weight: 1, status: "pending" },
      { id: "group", parent: "root", title: "親", weight: 1, status: "pending" },
      ...leaves.map((item, index) => ({
        id: `leaf${index}`,
        parent: "group",
        title: "葉",
        weight: item.weight,
        status: item.status,
        done: [
          item.status === "completed"
            ? item.units.total
            : item.status === "pending"
              ? 0
              : item.units.done,
          item.units.total,
        ] as [number, number],
      })),
    ];
    const tree = new TaskTree(tasks);
    for (const [index, item] of leaves.entries()) {
      const status = item.status === "pending" ? "blocked" : "pending";
      tree.apply({
        op: "update",
        id: `leaf${index}`,
        status,
        done: [0, item.units.total],
        weight: item.weight + 1,
        note: `更新${index}`,
      });
      expect(tree.tasks().find((task) => task.id === `leaf${index}`)).toMatchObject({
        status,
        done: [0, item.units.total],
        weight: item.weight + 1,
        note: `更新${index}`,
      });
      for (const id of ["root", "group"]) {
        const expected = measureTask(tree.tasks(), id);
        const actual = tree.measure(id);
        expect(actual.status).toBe(expected.status);
        expect(actual.leaves).toEqual(expected.leaves);
        for (const state of ["pending", "in_progress", "completed", "blocked"] as const)
          expect(actual.parts[state]).toBeCloseTo(expected.parts[state], 12);
      }
    }
  },
);

test.prop([fc.integer({ min: 3, max: 100 })])(
  "同じ進行中のまま単位が増えたときも全祖先の割合を更新する",
  (total) => {
    const tree = new TaskTree();
    tree.apply({ op: "add", id: "r" });
    tree.apply({ op: "add", id: "g", parent: "r" });
    tree.apply({ op: "add", id: "leaf", parent: "g", done: [1, total] });
    tree.apply({ op: "update", id: "leaf", done: [2, total] });
    for (const id of ["r", "g", "leaf"]) {
      expect(tree.measure(id).status).toBe("in_progress");
      expect(tree.measure(id).parts.completed).toBeCloseTo(2 / total, 12);
    }
  },
);

test.prop([fc.integer({ min: 2, max: 16 })])(
  "子をすべて削除して同じIDを追加しても親の集計を再開する",
  (count) => {
    const tree = new TaskTree();
    tree.apply({ op: "add", id: "r" });
    for (let index = 0; index < count; index++)
      tree.apply({ op: "add", id: `child${index}`, parent: "r" });
    for (let index = 0; index < count; index++) tree.apply({ op: "remove", id: `child${index}` });
    const id = `child${count - 1}`;
    tree.apply({ op: "add", id, parent: "r", status: "completed" });
    expect(tree.tasks().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "r", status: "completed" },
      { id, status: "completed" },
    ]);
    expect(tree.measure("r")).toEqual({
      status: "completed",
      parts: { pending: 0, in_progress: 0, completed: 1, blocked: 0 },
      leaves: { total: 1, pending: 0, in_progress: 0, completed: 1, blocked: 0 },
    });
    tree.apply({ op: "remove", id });
    tree.apply({ op: "add", id: "fresh", parent: "r" });
    expect(tree.tasks().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "r", status: "pending" },
      { id: "fresh", status: "pending" },
    ]);
    expect(tree.measure("r").leaves).toEqual({
      total: 1,
      pending: 1,
      in_progress: 0,
      completed: 0,
      blocked: 0,
    });
  },
);
