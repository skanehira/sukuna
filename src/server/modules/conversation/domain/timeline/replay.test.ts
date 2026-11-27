import { describe, expect, it } from "vitest";
import { replayTimeline } from "./replay";
import { formatProgress } from "./tree";

describe("タイムラインの復元", () => {
  it("末端の単位変更を祖先すべての割合と操作順の履歴に伝える", () => {
    const timeline = replayTimeline({
      version: 1,
      reports: [],
      journal: [
        {
          at: 1,
          toolUseId: "plan",
          ops: [
            { op: "add", id: "r" },
            { op: "add", id: "p", parent: "r" },
            { op: "add", id: "c", parent: "p" },
          ],
        },
        { at: 2, toolUseId: "units", ops: [{ op: "update", id: "c", done: [1, 2] }] },
      ],
    });
    expect({
      tasks: timeline.tasks.map(({ id, status, completed }) => ({ id, status, completed })),
      history: timeline.history
        .filter((entry) => entry.at === 2)
        .map(({ taskId, completedBefore, completedAfter }) => ({
          taskId,
          completedBefore,
          completedAfter,
        })),
    }).toEqual({
      tasks: [
        { id: "r", status: "in_progress", completed: 0.5 },
        { id: "p", status: "in_progress", completed: 0.5 },
        { id: "c", status: "in_progress", completed: 0.5 },
      ],
      history: [
        { taskId: "p", completedBefore: 0, completedAfter: 0.5 },
        { taskId: "r", completedBefore: 0, completedAfter: 0.5 },
        { taskId: "c", completedBefore: 0, completedAfter: 0.5 },
      ],
    });
  });
  it("丸め境界の計算をメモ変更では保ち、子の重み変更後は新しい境界へ更新する", () => {
    const timeline = replayTimeline({
      version: 1,
      reports: [],
      journal: [
        {
          at: 1,
          toolUseId: "plan",
          ops: [
            { op: "add", id: "r" },
            { op: "add", id: "a", parent: "r", status: "completed", weight: 5 },
            { op: "add", id: "b", parent: "r", status: "completed", weight: 6 },
            { op: "add", id: "p", parent: "r", weight: 19989 },
          ],
        },
        { at: 2, toolUseId: "note", ops: [{ op: "update", id: "r", note: "メモ" }] },
        { at: 3, toolUseId: "a", ops: [{ op: "update", id: "a", weight: 10 }] },
        { at: 4, toolUseId: "b", ops: [{ op: "update", id: "b", weight: 11 }] },
        { at: 5, toolUseId: "p", ops: [{ op: "update", id: "p", weight: 19979 }] },
      ],
    });
    expect({
      completed: timeline.trees[0]!.completed,
      formatted: formatProgress(timeline.trees[0]!.completed),
      memo: timeline.history
        .filter((entry) => entry.at === 2)
        .map(({ completedBefore, completedAfter, note }) => ({
          completedBefore,
          completedAfter,
          note,
        })),
    }).toEqual({
      completed: 0.0010500000000000002,
      formatted: "0.11%",
      memo: [
        {
          completedBefore: 0.0005499999999999999,
          completedAfter: 0.0005499999999999999,
          note: "メモ",
        },
      ],
    });
  });
  it.each([
    { completed: 11, split: 5, value: 0.0005499999999999999, text: "0.05%" },
    { completed: 21, split: 10, value: 0.0010500000000000002, text: "0.11%" },
    { completed: 31, split: 15, value: 0.0015500000000000002, text: "0.16%" },
    { completed: 19999, split: 10000, value: 0.9999, text: "99.99%" },
  ])(
    "重み$completedの丸め境界で割合と履歴と表示をプラグインに合わせる",
    ({ completed, split, value, text }) => {
      const timeline = replayTimeline({
        version: 1,
        reports: [],
        journal: [
          {
            at: 1,
            toolUseId: "plan",
            ops: [
              { op: "add", id: "r" },
              { op: "add", id: "a", parent: "r", status: "completed", weight: split },
              { op: "add", id: "b", parent: "r", status: "completed", weight: completed - split },
              { op: "add", id: "p", parent: "r", weight: 20000 - completed },
            ],
          },
        ],
      });
      expect({
        completed: timeline.trees[0]!.completed,
        task: timeline.tasks[0]!.completed,
        history: timeline.history[0]!.completedAfter,
        formatted: formatProgress(timeline.trees[0]!.completed),
      }).toEqual({ completed: value, task: value, history: value, formatted: text });
    },
  );
  it("単位と重みの変更と子の削除を操作順に親の割合と履歴へ反映する", () => {
    const timeline = replayTimeline({
      version: 1,
      reports: [],
      journal: [
        {
          at: 1,
          toolUseId: "add",
          ops: [
            { op: "add", id: "root" },
            { op: "add", id: "a", parent: "root", status: "completed", weight: 3 },
            { op: "add", id: "b", parent: "root" },
          ],
        },
        { at: 2, toolUseId: "units", ops: [{ op: "update", id: "b", done: [1, 2] }] },
        { at: 3, toolUseId: "weight", ops: [{ op: "update", id: "a", weight: 1 }] },
        { at: 4, toolUseId: "remove", ops: [{ op: "remove", id: "a" }] },
        { at: 5, toolUseId: "complete", ops: [{ op: "update", id: "b", done: [2, 2] }] },
      ],
    });
    expect({
      tree: timeline.trees[0],
      tasks: timeline.tasks,
      history: timeline.history
        .filter((entry) => entry.taskId === "root")
        .map(({ at, from, to, completedBefore, completedAfter }) => ({
          at,
          from,
          to,
          completedBefore,
          completedAfter,
        })),
    }).toEqual({
      tree: {
        id: "root",
        title: "root",
        status: "completed",
        completed: 1,
        parts: { pending: 0, in_progress: 0, completed: 1, blocked: 0 },
        leaves: { pending: 0, in_progress: 0, completed: 1, blocked: 0, total: 1 },
        startedAt: 1,
      },
      tasks: [
        {
          id: "root",
          parent: null,
          title: "root",
          status: "completed",
          weight: 1,
          completed: 1,
          units: "1 / 1",
        },
        {
          id: "b",
          parent: "root",
          title: "b",
          status: "completed",
          weight: 1,
          done: [2, 2],
          completed: 1,
          units: "2 / 2",
        },
      ],
      history: [
        { at: 5, from: "in_progress", to: "completed", completedBefore: 0.5, completedAfter: 1 },
        {
          at: 4,
          from: "in_progress",
          to: "in_progress",
          completedBefore: 0.75,
          completedAfter: 0.5,
        },
        {
          at: 3,
          from: "in_progress",
          to: "in_progress",
          completedBefore: 0.875,
          completedAfter: 0.75,
        },
        {
          at: 2,
          from: "in_progress",
          to: "in_progress",
          completedBefore: 0.75,
          completedAfter: 0.875,
        },
        { at: 1, from: "completed", to: "in_progress", completedBefore: 1, completedAfter: 0.75 },
        { at: 1, from: "pending", to: "completed", completedBefore: 0, completedAfter: 1 },
        { at: 1, from: null, to: "pending", completedBefore: 0, completedAfter: 0 },
      ],
    });
  });
  it.each([
    { shape: "wide", count: 1000 },
    { shape: "wide", count: 4000 },
    { shape: "wide", count: 10000 },
    { shape: "deep", count: 200 },
  ])(
    "$shape の正常な計画を復元し全タスクと末端を返す",
    ({ shape, count }) => {
      const timeline = replayTimeline({
        version: 1,
        reports: [],
        journal: [
          {
            at: 1,
            toolUseId: "plan",
            ops: [
              { op: "add", id: "root" },
              ...Array.from({ length: count }, (_, index) => ({
                op: "add" as const,
                id: `task${index}`,
                parent: shape === "wide" || index === 0 ? "root" : `task${index - 1}`,
              })),
            ],
          },
        ],
      });
      expect({
        tasks: timeline.tasks.length,
        leaves: timeline.trees[0]?.leaves,
        status: timeline.trees[0]?.status,
        completed: timeline.trees[0]?.completed,
        history: timeline.history.length,
      }).toEqual({
        tasks: count + 1,
        leaves: {
          pending: shape === "wide" ? count : 1,
          in_progress: 0,
          completed: 0,
          blocked: 0,
          total: shape === "wide" ? count : 1,
        },
        status: "pending",
        completed: 0,
        history: count + 1,
      });
    },
    20_000,
  );
  it("時刻順に復元し深さ優先のタスクと親の変更履歴、報告を返す", () => {
    expect(
      replayTimeline({
        version: 1,
        journal: [
          {
            at: 20,
            toolUseId: "update",
            agentId: "agent",
            ops: [{ op: "update", id: "child", status: "completed", note: "完了" }],
          },
          {
            at: 10,
            toolUseId: "add",
            ops: [
              { op: "add", id: "root", title: "計画" },
              { op: "add", id: "other" },
              { op: "add", id: "child", parent: "root", done: [1, 2], description: "説明" },
            ],
          },
        ],
        reports: [
          { at: 1, text: "古い報告" },
          { at: 180001, text: "新しい報告" },
        ],
        comments: [
          { at: 20, taskId: "child", text: "後" },
          { at: 10, taskId: "child", text: "前" },
        ],
      }),
    ).toEqual({
      defaultTreeId: "other",
      trees: [
        {
          id: "root",
          title: "計画",
          status: "completed",
          completed: 1,
          parts: { pending: 0, in_progress: 0, completed: 1, blocked: 0 },
          leaves: { total: 1, pending: 0, in_progress: 0, completed: 1, blocked: 0 },
          startedAt: 10,
        },
        {
          id: "other",
          title: "other",
          status: "pending",
          completed: 0,
          parts: { pending: 1, in_progress: 0, completed: 0, blocked: 0 },
          leaves: { total: 1, pending: 1, in_progress: 0, completed: 0, blocked: 0 },
          startedAt: 10,
        },
      ],
      tasks: [
        {
          id: "root",
          parent: null,
          title: "計画",
          status: "completed",
          weight: 1,
          completed: 1,
          units: "1 / 1",
        },
        {
          id: "child",
          parent: "root",
          title: "child",
          status: "completed",
          weight: 1,
          done: [2, 2],
          description: "説明",
          note: "完了",
          completed: 1,
          units: "2 / 2",
        },
        {
          id: "other",
          parent: null,
          title: "other",
          status: "pending",
          weight: 1,
          completed: 0,
          units: "0 / 1",
        },
      ],
      history: [
        {
          at: 20,
          taskId: "root",
          title: "計画",
          from: "in_progress",
          to: "completed",
          weight: 1,
          completedBefore: 0.5,
          completedAfter: 1,
          description: null,
          note: null,
          agentId: "agent",
        },
        {
          at: 20,
          taskId: "child",
          title: "child",
          from: "in_progress",
          to: "completed",
          weight: 1,
          completedBefore: 0.5,
          completedAfter: 1,
          description: null,
          note: "完了",
          agentId: "agent",
        },
        {
          at: 10,
          taskId: "root",
          title: "計画",
          from: "pending",
          to: "in_progress",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0.5,
          description: null,
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "child",
          title: "child",
          from: null,
          to: "in_progress",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0.5,
          description: "説明",
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "other",
          title: "other",
          from: null,
          to: "pending",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0,
          description: null,
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "root",
          title: "計画",
          from: null,
          to: "pending",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0,
          description: null,
          note: null,
          agentId: null,
        },
      ],
      reports: [
        { at: 180001, text: "新しい報告" },
        { at: 1, text: "古い報告" },
      ],
      unresolvedComments: [],
      comments: [
        { at: 10, taskId: "child", text: "前" },
        { at: 20, taskId: "child", text: "後" },
      ],
    });
  });

  it("進行中の木を優先し無ければ最後に追加した木を選ぶ", () => {
    const timeline = replayTimeline({
      version: 1,
      journal: [
        {
          at: 0,
          toolUseId: "1",
          ops: [
            { op: "add", id: "active", status: "in_progress" },
            { op: "add", id: "last" },
          ],
        },
      ],
      reports: [],
    });
    expect({
      selected: timeline.defaultTreeId,
      starts: timeline.trees.map((tree) => tree.startedAt),
    }).toEqual({ selected: "active", starts: [null, null] });
  });

  it("完了と未着手の子が混在する進行中の木も最新の未着手の木より優先する", () => {
    const timeline = replayTimeline({
      version: 1,
      journal: [
        {
          at: 10,
          toolUseId: "plan",
          ops: [
            { op: "add", id: "active" },
            { op: "add", id: "done", parent: "active", status: "completed" },
            { op: "add", id: "pending", parent: "active" },
            { op: "add", id: "last" },
          ],
        },
      ],
      reports: [],
    });
    expect(timeline.defaultTreeId).toBe("active");
  });
});

it("完了の単位がない葉の単位を状態から補い、詰まりの変更も親の履歴に残す", () => {
  const result = replayTimeline({
    version: 1,
    reports: [],
    journal: [
      {
        at: 1,
        toolUseId: "plan",
        ops: [
          { op: "add", id: "r" },
          { op: "add", id: "a", parent: "r" },
          { op: "add", id: "done", status: "completed" },
        ],
      },
      { at: 2, toolUseId: "blocked", ops: [{ op: "update", id: "a", status: "blocked" }] },
    ],
  });
  expect(result.tasks.map(({ id, units }) => ({ id, units }))).toEqual([
    { id: "r", units: "0 / 1" },
    { id: "a", units: "0 / 1" },
    { id: "done", units: "1 / 1" },
  ]);
  expect(
    result.history.filter(({ at }) => at === 2).map(({ taskId, to }) => ({ taskId, to })),
  ).toEqual([
    { taskId: "r", to: "blocked" },
    { taskId: "a", to: "blocked" },
  ]);
  expect(result.unresolvedComments).toEqual([]);
});

it("無効な操作を履歴へ入れず後続の有効な更新を適用する", () => {
  const result = replayTimeline({
    version: 1,
    reports: [],
    journal: [
      {
        at: 1,
        toolUseId: "ops",
        ops: [
          { op: "add", id: "r" },
          { op: "add", id: "leaf", parent: "r" },
          { op: "add", id: "r" },
          { op: "update", id: "missing" },
          { op: "update", id: "leaf", weight: 0 },
          { op: "update", id: "leaf", done: [0, 1, 2] },
          { op: "update", id: "r", status: "blocked" },
          { op: "update", id: "leaf", title: "有効" },
        ],
      },
    ],
  });
  expect(result.tasks.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: "r", title: "r" },
    { id: "leaf", title: "有効" },
  ]);
  expect(result.history.map(({ taskId, title }) => ({ taskId, title }))).toEqual([
    { taskId: "leaf", title: "有効" },
    { taskId: "leaf", title: "leaf" },
    { taskId: "r", title: "r" },
  ]);
});

it("項目の省略ではメモを残し、親の題名だけの更新も履歴へ反映する", () => {
  const result = replayTimeline({
    version: 1,
    reports: [],
    journal: [
      {
        at: 1,
        toolUseId: "plan",
        ops: [
          { op: "add", id: "r", note: "既存メモ" },
          { op: "add", id: "leaf", parent: "r" },
        ],
      },
      {
        at: 2,
        toolUseId: "title",
        ops: [{ op: "update", id: "r", title: "新題名", status: "blocked" }],
      },
      { at: 3, toolUseId: "noop", ops: [{ op: "update", id: "r" }] },
    ],
  });
  expect(result.tasks[0]).toMatchObject({ title: "新題名", note: "既存メモ" });
  expect(result.comments).toEqual([]);
  expect(result.history.filter(({ at }) => at > 1).map(({ at, title }) => ({ at, title }))).toEqual(
    [
      { at: 3, title: "新題名" },
      { at: 2, title: "新題名" },
    ],
  );
});
