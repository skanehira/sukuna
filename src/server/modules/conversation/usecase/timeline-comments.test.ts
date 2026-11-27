import { describe, expect, it } from "vitest";
import { buildTimelineComments } from "./timeline-comments";

const taskCases = [
  { taskId: "t1", title: "題名" },
  { taskId: "t1", title: "CSV「BOM」の扱い" },
  { taskId: "task 1", title: "題名" },
  { taskId: "task[1].*", title: "題名" },
  { taskId: "t1", title: "空白の ある題名" },
];

describe("タスクの相談コメント", () => {
  it.each(
    taskCases.flatMap((task) =>
      [
        { origin: "developer", accepted: true },
        { origin: "queued", accepted: true },
        { origin: "interrupt", accepted: true },
        { origin: "stock", accepted: true },
        { origin: "answer_text", accepted: true },
        { origin: "flow", accepted: false },
        { origin: "resume", accepted: false },
        { origin: "finish_proposal", accepted: false },
      ].map((source) => ({ ...task, ...source })),
    ),
  )(
    "$taskId「$title」の $origin の相談を由来に従って取り込む",
    ({ taskId, title, origin, accepted }) => {
      const events = [
        {
          seq: 1,
          type: "user_message",
          createdAt: 10,
          payload: {
            origin,
            text: `タイムラインのタスク ${taskId}「${title}」について: 確認してください`,
          },
        },
      ];
      expect(buildTimelineComments(taskId, [], events)).toEqual(
        accepted ? [{ at: 10, taskId, text: "確認してください" }] : [],
      );
    },
  );

  it.each(taskCases)(
    "$taskId「$title」の複数行の相談を前後の別タスクと分離する",
    ({ taskId, title }) => {
      const events = [
        {
          seq: 1,
          type: "user_message",
          createdAt: 10,
          payload: {
            origin: "developer",
            text: `下書き
タイムラインのタスク other task「前「題名」」について: 前の相談
前の続き

タイムラインのタスク ${taskId}「変更前の${title}」について: 対象の相談
対象の続き

タイムラインのタスク ${taskId}-other「後「題名」」について: 後の相談
後の続き

タイムラインのタスク ${taskId}「${title}」について: 最後の相談
最後の続き`,
          },
        },
      ];
      expect(buildTimelineComments(taskId, [], events)).toEqual([
        { at: 10, taskId, text: "対象の相談\n対象の続き" },
        { at: 10, taskId, text: "最後の相談\n最後の続き" },
      ]);
    },
  );

  it("対象タスクの相談を会話とファイルから集め同時刻と同文を重複排除して古い順にする", () => {
    const events = [
      {
        seq: 1,
        type: "user_message",
        createdAt: 20,
        payload: { origin: "developer", text: "タイムラインのタスク t1「古い題名」について: 重複" },
      },
      {
        seq: 2,
        type: "user_message",
        createdAt: 10,
        payload: {
          origin: "queued",
          text: "下書き\n\nタイムラインのタスク t1「題名」について: 先の相談\n続き",
        },
      },
      {
        seq: 3,
        type: "user_message",
        createdAt: 30,
        payload: { origin: "developer", text: "タイムラインのタスク t2「別」について: 別の相談" },
      },
      {
        seq: 4,
        type: "assistant_text",
        createdAt: 40,
        payload: { text: "タイムラインのタスク t1「題名」について: AI" },
      },
      {
        seq: 5,
        type: "user_message",
        createdAt: 50,
        payload: { origin: "flow", text: "タイムラインのタスク t1「題名」について: 自動" },
      },
      {
        seq: 6,
        type: "user_message",
        createdAt: 60,
        payload: {
          origin: "developer",
          text: "タイムラインのタスク t1「題名」について: 会話だけの相談",
        },
      },
    ];
    expect(
      buildTimelineComments(
        "t1",
        [
          { at: 20, taskId: "t1", text: "重複" },
          { at: 5, taskId: "t1", text: "ファイルの相談" },
          { at: 1, taskId: "t2", text: "別" },
        ],
        events,
      ),
    ).toEqual([
      { at: 5, taskId: "t1", text: "ファイルの相談" },
      { at: 10, taskId: "t1", text: "先の相談\n続き" },
      { at: 20, taskId: "t1", text: "重複" },
      { at: 60, taskId: "t1", text: "会話だけの相談" },
    ]);
  });
});
