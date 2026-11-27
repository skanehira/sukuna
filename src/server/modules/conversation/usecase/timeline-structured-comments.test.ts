import { describe, expect, it } from "vite-plus/test";
import { buildTimelineComments } from "./timeline-comments";

const cases = [
  {
    name: "別IDが同じ前置きを作る",
    tasks: [
      { id: "a「b", title: "c" },
      { id: "a", title: "b「c" },
    ],
    text: "タイムラインのタスク a「b「c」について: 本文",
    reason: "ambiguous_task",
  },
  {
    name: "別IDの前置きが包含される",
    tasks: [
      { id: "a", title: "b" },
      { id: "a「b」について: x", title: "c" },
    ],
    text: "タイムラインのタスク a「b」について: x「c」について: 本文",
    reason: "ambiguous_boundary",
  },
  {
    name: "同一IDの現旧題名が包含される",
    tasks: [
      { id: "a", title: "b" },
      { id: "a", title: "b」について: c" },
    ],
    text: "タイムラインのタスク a「b」について: c」について: 本文",
    reason: "ambiguous_boundary",
  },
  {
    name: "題名の改行の中に別の前置きがある",
    tasks: [
      { id: "a", title: "b\nタイムラインのタスク c「d」について: e" },
      { id: "c", title: "d" },
    ],
    text: "タイムラインのタスク a「b\nタイムラインのタスク c「d」について: e」について: 本文",
    reason: "ambiguous_boundary",
  },
] as const;

describe("構造化された相談と旧発言の曖昧さ", () => {
  it("曖昧な箇所を含む旧入力は前後を含む原文全体を残し、構造化相談だけをタスクへ付ける", () => {
    const text =
      "下書き\n\nタイムラインのタスク good「題名」について: 先の相談\n\nタイムラインのタスク a「b「c」について: 曖昧な相談\n末尾\n";
    expect(
      buildTimelineComments(
        [{ id: "good", title: "題名" }, ...cases[0].tasks],
        [],
        [
          {
            type: "user_message",
            createdAt: 20,
            payload: {
              origin: "queued",
              text: `構造化部分\n\n${text}`,
              timeline_comments: [{ task_id: "good", text: "構造化の本文\n" }],
              timeline_legacy_texts: [text, text],
            },
          },
          {
            type: "user_message",
            createdAt: 10,
            payload: { origin: "developer", text: cases[0].text },
          },
        ],
      ),
    ).toEqual({
      comments: [{ at: 20, taskId: "good", text: "構造化の本文\n" }],
      unresolvedComments: [
        { at: 10, text: cases[0].text, reason: "ambiguous_task" },
        { at: 20, text, reason: "ambiguous_task" },
      ],
    });
  });

  it("構造化の空配列だけの発言では旧前置きの解析を行わずファイルの相談を保つ", () => {
    expect(
      buildTimelineComments(
        [{ id: "a", title: "b" }],
        [{ at: 1, taskId: "a", text: "ファイル" }],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: {
              origin: "developer",
              text: "タイムラインのタスク a「b」について: 本文",
              timeline_comments: [],
            },
          },
        ],
      ),
    ).toEqual({ comments: [{ at: 1, taskId: "a", text: "ファイル" }], unresolvedComments: [] });
  });

  it("一意な旧入力の複数タスクと現旧題名を区切り以外の空白改行を保って取り込む", () => {
    expect(
      buildTimelineComments(
        [
          { id: "a", title: "前の題名" },
          { id: "a", title: "今の題名" },
          { id: "b", title: "別の題名" },
        ],
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: {
              origin: "developer",
              text: "下書き\n\nタイムラインのタスク a「前の題名」について:   先の相談\n続き  \n\nタイムラインのタスク b「別の題名」について: 別の相談\n\nタイムラインのタスク a「今の題名」について: 最後の相談\n\n",
            },
          },
        ],
      ),
    ).toEqual({
      comments: [
        { at: 10, taskId: "a", text: "  先の相談\n続き  " },
        { at: 10, taskId: "b", text: "別の相談" },
        { at: 10, taskId: "a", text: "最後の相談\n\n" },
      ],
      unresolvedComments: [],
    });
  });
  it.each(cases)("$name の旧発言をタスクに付けず原文を返す", ({ tasks, text, reason }) => {
    expect(
      buildTimelineComments(
        tasks,
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: { origin: "developer", text },
          },
        ],
      ),
    ).toEqual({ comments: [], unresolvedComments: [{ at: 10, text, reason }] });
  });

  it.each(
    cases.flatMap((value) =>
      [
        "developer",
        "queued",
        "interrupt",
        "stock",
        "answer_text",
        "flow",
        "resume",
        "finish_proposal",
      ].map((origin) => ({ ...value, origin })),
    ),
  )("$name の $origin は構造化IDと本文で判定する", ({ tasks, text, origin }) => {
    const body = "  本文\nタイムラインのタスク a「b」について: 引用\r\n\n";
    const taskId = tasks[0].id;
    expect(
      buildTimelineComments(
        tasks,
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: { origin, text, timeline_comments: [{ task_id: taskId, text: body }] },
          },
        ],
      ),
    ).toEqual({
      comments: ["developer", "queued", "interrupt", "stock", "answer_text"].includes(origin)
        ? [{ at: 10, taskId, text: body }]
        : [],
      unresolvedComments: [],
    });
  });

  it("同一IDと同一前置きの重複候補は一意な旧発言として取り込む", () => {
    expect(
      buildTimelineComments(
        [
          { id: "a", title: "b" },
          { id: "a", title: "b" },
        ],
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: { origin: "developer", text: "タイムラインのタスク a「b」について: 本文\n" },
          },
        ],
      ),
    ).toEqual({ comments: [{ at: 10, taskId: "a", text: "本文\n" }], unresolvedComments: [] });
  });

  it("構造化の空配列では前置きを再解析せず混在した旧入力だけを抽出する", () => {
    expect(
      buildTimelineComments(
        [{ id: "a", title: "b" }],
        [],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: {
              origin: "queued",
              text: "タイムラインのタスク a「b」について: 構造化部分",
              timeline_comments: [],
              timeline_legacy_texts: ["タイムラインのタスク a「b」について: 旧入力\n"],
            },
          },
        ],
      ),
    ).toEqual({ comments: [{ at: 10, taskId: "a", text: "旧入力\n" }], unresolvedComments: [] });
  });

  it("構造化の複数タスクとファイルの同時刻同文を重複排除して古い順にする", () => {
    expect(
      buildTimelineComments(
        [],
        [
          { at: 10, taskId: "a", text: "一致" },
          { at: 1, taskId: "a", text: "ファイル" },
        ],
        [
          {
            type: "user_message",
            createdAt: 10,
            payload: {
              origin: "developer",
              text: "表示の文",
              timeline_comments: [
                { task_id: "a", text: "一致" },
                { task_id: "b\n「", text: "\n  本文 \n" },
              ],
            },
          },
        ],
      ),
    ).toEqual({
      comments: [
        { at: 1, taskId: "a", text: "ファイル" },
        { at: 10, taskId: "a", text: "一致" },
        { at: 10, taskId: "b\n「", text: "\n  本文 \n" },
      ],
      unresolvedComments: [],
    });
  });
});
