import { expect, it } from "vite-plus/test";
import type { Timeline } from "../../shared/progress/schema";
import { nextTree, timelineLines } from "./timeline-pane";

const data: Timeline = {
  defaultTreeId: "old",
  tasks: [
    {
      id: "old",
      parent: null,
      title: "会計",
      status: "in_progress",
      weight: 1,
      completed: 0.75,
      units: "1 / 2",
    },
    {
      id: "paid",
      parent: "old",
      title: "入金",
      status: "completed",
      weight: 3,
      completed: 1,
      units: "1 / 1",
    },
    {
      id: "bills",
      parent: "old",
      title: "請求",
      status: "pending",
      weight: 1,
      completed: 0,
      units: "0 / 1",
    },
    {
      id: "new",
      parent: null,
      title: "新しい木",
      status: "pending",
      weight: 1,
      completed: 0,
      units: "0 / 1",
    },
  ],
  trees: [
    {
      id: "old",
      title: "会計",
      status: "in_progress",
      completed: 0.75,
      parts: { completed: 0.75, in_progress: 0, pending: 0.25, blocked: 0 },
      leaves: { completed: 1, pending: 1, in_progress: 0, blocked: 0, total: 2 },
      startedAt: 1000,
    },
    {
      id: "new",
      title: "新しい木",
      status: "pending",
      completed: 0,
      parts: { completed: 0, in_progress: 0, pending: 1, blocked: 0 },
      leaves: { completed: 0, pending: 1, in_progress: 0, blocked: 0, total: 1 },
      startedAt: null,
    },
  ],
  reports: [
    { at: 4000, text: "新しい報告" },
    { at: 2000, text: "前の報告" },
  ],
  history: [],
  comments: [],
  unresolvedComments: [],
};
it("木の位置、状態、末端の内訳、深さと状態の印、報告、番号付き操作に使う行を作る", () => {
  const rows = timelineLines(data, null, false, new Date(61000));
  expect(rows.map((row) => row.text)).toEqual([
    "木  1 / 2  会計",
    "状態  進行中",
    "進み  75.00%  (末端のタスク 1 / 2)",
    "内訳  完了 1 · 未着手 1",
    "経過  1分",
    "",
    "タスク  状態  進み",
    "◐ 会計  進行中  75.00%",
    "    ● 入金  完了  100.00%",
    "    ○ 請求  未着手  0.00%",
    "報告 (3 分ごと)",
    expect.any(String),
    "新しい報告",
    expect.any(String),
    "前の報告",
    "続きを依頼する",
  ]);
  expect(rows[5].progress).toEqual([0.75, 0, 0, 0.25]);
  expect(rows[8]).toMatchObject({ id: "paid", action: "timeline.task" });
  expect(rows.at(-1)?.kind).toBe("menu");
});
it("次と前を選び、木が消えたときだけ既定へ戻す", () => {
  expect(nextTree(data, null, 1)).toBe("new");
  expect(nextTree(data, "new", -1)).toBe("old");
  expect(nextTree(data, "old", -1)).toBe("old");
  expect(timelineLines(data, "removed", false, new Date(61000))[0].text).toBe("木  1 / 2  会計");
});
it("計画がなくても報告を表示し、既読のファイルを返すエラーと内容のないエラーを区別する", () => {
  const now = new Date(61000);
  const noPlan = timelineLines({ ...data, trees: [], tasks: [] }, null, false, now);
  expect(noPlan.map((row) => row.text)).toEqual([
    "タスクの木はまだありません。AI が計画を立てると、ここに出ます。",
    "報告 (3 分ごと)",
    expect.any(String),
    "新しい報告",
    expect.any(String),
    "前の報告",
  ]);
  expect(timelineLines(null, null, false, now).at(-1)?.text).toBe("報告はまだありません");
  const error = "タイムラインのファイルを読めませんでした。前に読めた内容を出しています。";
  expect(timelineLines(null, null, true, now).map((line) => line.text)).toEqual([error]);
  expect(
    timelineLines(data, "new", true, now)
      .slice(0, 2)
      .map((row) => row.text),
  ).toEqual([error, "木  2 / 2  新しい木"]);
});
