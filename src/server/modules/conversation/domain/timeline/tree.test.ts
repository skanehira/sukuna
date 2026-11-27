import { describe, expect, it } from "vitest";
import { applyOps, measureTask, formatProgress, type Task, type TaskOp } from "./tree";

const root: Task = { id: "root", parent: null, title: "計画", status: "pending", weight: 1 };
const leaf: Task = { id: "leaf", parent: "root", title: "作業", status: "pending", weight: 1 };

describe("タスクの操作", () => {
  it("追加時に重みと状態を補い子孫も削除する", () => {
    const tasks = applyOps(
      [],
      [
        { op: "add", id: "root", title: "計画" },
        { op: "add", id: "leaf", parent: "root", title: "作業" },
      ],
    );
    expect(tasks).toEqual([root, leaf]);
    expect(
      applyOps(tasks, [
        { op: "remove", id: "root" },
        { op: "add", id: "new" },
      ]),
    ).toEqual([{ id: "new", title: "new", parent: null, weight: 1, status: "pending" }]);
  });

  it.each([
    { op: "add", id: "root" },
    { op: "add", id: "other", parent: "missing" },
    { op: "update", id: "missing" },
    { op: "remove", id: "missing" },
    ...[0, -1].map((weight) => ({ op: "update", id: "root", weight })),
    ...[[-1, 2], [3, 2], [0, 0], [1]].map((done) => ({ op: "update", id: "root", done })),
    { op: "update", id: "root", status: "pending", done: [1, 2] },
  ])("受け付けない操作 %j だけ飛ばす", (bad) => {
    expect(applyOps([root], [bad as TaskOp, { op: "update", id: "root", title: "続行" }])).toEqual([
      { ...root, title: "続行" },
    ]);
  });

  it.each([
    [[0, 2], "pending", [0, 2]],
    [[1, 2], "in_progress", [1, 2]],
    [[2, 2], "completed", [2, 2]],
  ] as const)("単位 %j から状態を求める", (done, status, expectedDone) => {
    expect(applyOps([root], [{ op: "update", id: "root", done: [...done] }])).toEqual([
      { ...root, status, done: expectedDone },
    ]);
  });

  it("完了にすると単位を全体に揃える", () => {
    expect(
      applyOps(
        [{ ...root, status: "in_progress", done: [1, 2] }],
        [{ op: "update", id: "root", status: "completed" }],
      ),
    ).toEqual([{ ...root, status: "completed", done: [2, 2] }]);
  });

  it("子のあるタスクの状態と単位を無視して説明などを適用する", () => {
    expect(
      applyOps(
        [root, leaf],
        [
          {
            op: "update",
            id: "root",
            status: "completed",
            done: [1, 2],
            title: "新計画",
            description: "説明",
            note: "メモ",
            weight: 3,
          },
        ],
      ),
    ).toEqual([{ ...root, title: "新計画", description: "説明", note: "メモ", weight: 3 }, leaf]);
  });
});

describe("進捗の按分", () => {
  it.each([
    [
      [
        { ...leaf, weight: 3, status: "completed" },
        { ...leaf, id: "b" },
      ],
      "75.00%",
    ],
    [
      [
        { ...leaf, status: "in_progress", done: [1, 2] },
        { ...leaf, id: "b", status: "completed" },
        { ...leaf, id: "c", weight: 3, status: "completed" },
      ],
      "90.00%",
    ],
  ] as [Task[], string][])("重みから割合 %s を求める", (children, expected) => {
    expect(formatProgress(measureTask([root, ...children], "root").parts.completed)).toBe(expected);
  });

  it("単位の途中は 50.00% で、完了以外の残りも状態別に返す", () => {
    expect(measureTask([{ ...root, status: "in_progress", done: [1, 2] }], "root")).toEqual({
      status: "in_progress",
      parts: { pending: 0, in_progress: 0.5, completed: 0.5, blocked: 0 },
      leaves: { total: 1, pending: 0, in_progress: 1, completed: 0, blocked: 0 },
    });
    expect(formatProgress(0.5)).toBe("50.00%");
  });

  it("残りが僅かでも 99.99% を上限にし全完了でのみ 100.00% にする", () => {
    const tasks = [
      root,
      { ...leaf, status: "completed" as const, weight: 1000000 },
      { ...leaf, id: "b" },
    ];
    expect(formatProgress(measureTask(tasks, "root").parts.completed)).toBe("99.99%");
    expect(
      formatProgress(
        measureTask(applyOps(tasks, [{ op: "update", id: "b", status: "completed" }]), "root").parts
          .completed,
      ),
    ).toBe("100.00%");
  });

  it.each([
    [["completed", "completed"], "completed"],
    [["in_progress", "blocked"], "in_progress"],
    [["blocked", "pending"], "blocked"],
    [["completed", "pending"], "in_progress"],
    [["pending", "pending"], "pending"],
  ] as [Task["status"][], Task["status"]][])(
    "子の状態 %j から親を %s にする",
    (statuses, expected) => {
      const tasks = applyOps(
        [root],
        statuses.map((status, i) => ({ op: "add", id: `child${i}`, parent: "root", status })),
      );
      expect(tasks).toEqual([
        { ...root, status: expected },
        ...statuses.map((status, i) => ({
          id: `child${i}`,
          parent: "root",
          title: `child${i}`,
          weight: 1,
          status,
        })),
      ]);
    },
  );
});
