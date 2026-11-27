import { expect, it } from "vite-plus/test";
import type { Timeline } from "../../shared/progress/schema";
import { taskDetailLines } from "./task-detail-pane";

const record = {
  taskId: "one",
  title: "帳票",
  at: 0,
  from: "pending" as const,
  to: "in_progress" as const,
  weight: 3,
  completedBefore: 0,
  completedAfter: 0.5,
  description: null,
  note: null,
  agentId: null,
};
const data: Timeline = {
  defaultTreeId: "root",
  trees: [
    {
      id: "root",
      title: "請求処理",
      status: "in_progress",
      completed: 0.5,
      startedAt: null,
      parts: { pending: 0, in_progress: 1, completed: 0, blocked: 0 },
      leaves: { total: 1, pending: 0, in_progress: 1, completed: 0, blocked: 0 },
    },
  ],
  tasks: [
    {
      id: "root",
      parent: null,
      title: "請求処理",
      status: "in_progress",
      completed: 0.5,
      weight: 1,
      units: "0 / 1",
    },
    {
      id: "one",
      parent: "root",
      title: "帳票",
      status: "in_progress",
      completed: 0.5,
      weight: 3,
      units: "1 / 2",
      description: "一行目\n二行目",
      note: "途中",
    },
  ],
  reports: [],
  comments: [
    { taskId: "one", at: 1000, text: "質問 A" },
    { taskId: "two", at: 2000, text: "別のタスク" },
    { taskId: "one", at: 3000, text: "質問 B\n続き" },
  ],
  unresolvedComments: [],
  history: [{ ...record, note: "新しい記録", agentId: "alpha" }, record],
};
it("選んだタスクの詳細、古い順の相談と新しい順の変更を別々に出す", () => {
  const rows = taskDetailLines(data, "one", false, new Date(61000));
  expect(rows.map(({ text }) => text)).toEqual([
    "タスク  帳票",
    "状態  進行中",
    "木  請求処理",
    "進み  50.00%",
    "重み  3",
    "完了した単位  1 / 2",
    "説明  一行目",
    "二行目",
    "メモ  途中",
    "コメント",
    expect.stringMatching(/あなた: 質問 A$/),
    expect.stringMatching(/あなた: 質問 B$/),
    "続き",
    "履歴",
    expect.stringMatching(/進行中  0\.00% → 50\.00%  重み 3  新しい記録  alpha$/),
    expect.stringMatching(/進行中  0\.00% → 50\.00%  重み 3$/),
    "このタスクについて相談する",
  ]);
});
it("説明やメモがないときの空欄と、消えたタスクを区別する", () => {
  const rows = taskDetailLines(data, "root", false, new Date(61000));
  expect(rows.map(({ text }) => text)).toContain("説明  —");
  expect(rows.map(({ text }) => text)).toContain("メモ  —");
  expect(rows.map(({ text }) => text)).toContain("コメントはありません");
  expect(
    taskDetailLines(data, "removed", false, new Date(61000)).some((line) => line.kind === "menu"),
  ).toBe(false);
});
