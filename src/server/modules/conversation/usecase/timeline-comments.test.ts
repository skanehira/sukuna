import { describe, expect, it } from "vitest";
import { buildTimelineComments } from "./timeline-comments";

describe("タスクの相談コメント", () => {
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
    ]);
  });
});
