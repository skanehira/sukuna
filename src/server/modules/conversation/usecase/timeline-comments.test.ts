import { describe, expect, it } from "vitest";
import { buildTimelineComments } from "./timeline-comments";

const taskCases = [
  { taskId: "t1", title: "題名" },
  { taskId: "t1", title: "CSV「BOM」の扱い" },
  { taskId: "task 1", title: "題名" },
  { taskId: "task[1].*", title: "題名" },
  { taskId: "t1", title: "空白の ある題名" },
  { taskId: "t1", title: "CSV」形式" },
  { taskId: "task\n1", title: "題名" },
  { taskId: "t1", title: "CSV\nBOMの扱い" },
  { taskId: "t1", title: "「完了」について: 表示を直す" },
  { taskId: "task「copy", title: "題名" },
  { taskId: "task", title: "copy「本当の題名" },
  { taskId: "", title: "題名" },
  { taskId: "t1", title: "前半\nタイムラインのタスク other「別」について: 後半" },
];

describe("タスクの相談コメント", () => {
  it.each(
    taskCases.flatMap((task) =>
      [
        "developer",
        "queued",
        "interrupt",
        "stock",
        "answer_text",
        "flow",
        "resume",
        "finish_proposal",
      ].map((origin) => ({ ...task, origin })),
    ),
  )(
    "候補が一意な $taskId「$title」の旧発言を $origin に従って取り込む",
    ({ taskId, title, origin }) => {
      expect(
        buildTimelineComments(
          [{ id: taskId, title }],
          [],
          [
            {
              type: "user_message",
              createdAt: 10,
              payload: {
                origin,
                text: `タイムラインのタスク ${taskId}「${title}」について:   本文\r\n\n`,
              },
            },
          ],
        ),
      ).toEqual({
        comments: ["developer", "queued", "interrupt", "stock", "answer_text"].includes(origin)
          ? [{ at: 10, taskId, text: "  本文\r\n\n" }]
          : [],
        unresolvedComments: [],
      });
    },
  );
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
            text: `タイムラインのタスク ${taskId}「${title}」について:   確認してください\n本文の続き  \n`,
            timeline_comments: [{ task_id: taskId, text: "  確認してください\n本文の続き  \n" }],
          },
        },
      ];
      expect(
        buildTimelineComments(
          [
            { id: taskId, title },
            { id: taskId === "task" ? "task「copy" : "task", title: "元タスク" },
            { id: "other", title: "別" },
            { id: taskId, title: "「完了" },
          ],
          [],
          events,
        ).comments,
      ).toEqual(accepted ? [{ at: 10, taskId, text: "  確認してください\n本文の続き  \n" }] : []);
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
            timeline_comments: [
              { task_id: "other task", text: "前の相談\n前の続き" },
              { task_id: taskId, text: "対象の相談\n対象の続き" },
              { task_id: `${taskId}-other`, text: "後の相談\n後の続き" },
              { task_id: taskId, text: "最後の相談\n最後の続き" },
            ],
          },
        },
      ];
      expect(
        buildTimelineComments(
          [
            { id: taskId, title },
            { id: taskId, title: `変更前の${title}` },
            { id: "other task", title: "前「題名」" },
            { id: `${taskId}-other`, title: "後「題名」" },
            { id: "other", title: "別" },
            { id: taskId, title: "「完了" },
          ],
          [],
          events,
        ).comments,
      ).toEqual([
        { at: 10, taskId: "other task", text: "前の相談\n前の続き" },
        { at: 10, taskId, text: "対象の相談\n対象の続き" },
        { at: 10, taskId: `${taskId}-other`, text: "後の相談\n後の続き" },
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
        [
          { id: "t1", title: "題名" },
          { id: "t1", title: "古い題名" },
          { id: "t2", title: "別" },
        ],
        [
          { at: 20, taskId: "t1", text: "重複" },
          { at: 5, taskId: "t1", text: "ファイルの相談" },
          { at: 1, taskId: "t2", text: "別" },
          { at: 20, taskId: "t2", text: "重複" },
        ],
        events,
      ).comments,
    ).toEqual([
      { at: 1, taskId: "t2", text: "別" },
      { at: 5, taskId: "t1", text: "ファイルの相談" },
      { at: 10, taskId: "t1", text: "先の相談\n続き" },
      { at: 20, taskId: "t1", text: "重複" },
      { at: 20, taskId: "t2", text: "重複" },
      { at: 30, taskId: "t2", text: "別の相談" },
      { at: 60, taskId: "t1", text: "会話だけの相談" },
    ]);
  });

  it("本文内の前置きに似た行と行途中の前置きを本文のまま保つ", () => {
    const text =
      "本文の途中の タイムラインのタスク other「別」について: 引用\nタイムラインのタスク の説明も見直す\n末尾  \n";
    expect(
      buildTimelineComments(
        [
          { id: "t1", title: "題名" },
          { id: "other", title: "別" },
        ],
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: {
              origin: "developer",
              text: `タイムラインのタスク t1「題名」について: ${text}`,
            },
          },
        ],
      ).comments,
    ).toEqual([{ at: 10, taskId: "t1", text }]);
  });
});
