import { describe, expect, it } from "vite-plus/test";
import { eventLines, switchLines } from "./lines";
import type { Event } from "./types";

const event = (seq: number, value: Omit<Event, "seq" | "createdAt">): Event =>
  ({ ...value, seq, createdAt: 0 }) as Event;
describe("会話の行", () => {
  it("AI の発言の本文の行だけに Markdown の印を付け、開発者の発言とツールの行には付けない", () => {
    const marked = (value: Event) =>
      eventLines(value, "c1", "/project").map((line) => line.markdown === true);
    expect(
      marked(
        event(1, {
          type: "assistant_text",
          payload: { text: "**一**\n二", parent_tool_use_id: null },
        }),
      ),
    ).toEqual([false, true, true]);
    expect(
      marked(
        event(2, {
          type: "user_message",
          payload: { text: "**指示**", origin: "developer", images: [] },
        }),
      ),
    ).toEqual([false, false]);
    expect(
      marked(
        event(3, {
          type: "tool_use",
          payload: {
            tool_use_id: "t",
            name: "Bash",
            input: { command: "ls" },
            parent_tool_use_id: null,
          },
        }),
      ),
    ).toEqual([false]);
  });
  it.each(["create", "edit", "update"] as const)(
    "%sの差分の本文を追加行として表示する",
    (change) => {
      const first = change === "create" ? 1 : 10;
      const diff: Event = {
        seq: 4,
        createdAt: 0,
        type: "diff",
        payload: {
          tool_use_id: "tool",
          path: "new.ts",
          change,
          content: "1行目\n2行目\n",
          hunks:
            change === "create"
              ? []
              : [
                  {
                    old_start: 10,
                    old_lines: 0,
                    new_start: 10,
                    new_lines: 2,
                    lines: ["+1行目", "+2行目"],
                  },
                ],
          truncated: false,
        },
      };
      expect(eventLines(diff, "c1", "/project")).toEqual([
        { kind: "add", text: `${first} +1行目`, seq: 4, seqLine: 0 },
        { kind: "add", text: `${first + 1} +2行目`, seq: 4, seqLine: 1 },
      ]);
    },
  );
  it.each(["", "1行だけ", "1行だけ\n"])(
    "新規ファイルの空本文と末尾改行を余分な行として数えない (%j)",
    (content) => {
      const diff: Event = {
        seq: 4,
        createdAt: 0,
        type: "diff",
        payload: {
          tool_use_id: "tool",
          path: "new.ts",
          change: "create",
          content,
          hunks: [],
          truncated: true,
        },
      };
      expect(eventLines(diff, "c1", "/project")).toEqual(
        content ? [{ kind: "add", text: "1 +1行だけ", seq: 4, seqLine: 0 }] : [],
      );
    },
  );
  it("発言は札と本文、画像の件数を順に並べる", () => {
    expect(
      eventLines(
        event(1, {
          type: "user_message",
          payload: {
            text: "指示\n次の行",
            images: [{ path: "image-1", media_type: "image/png" }],
            origin: "developer",
          },
        }),
        "c1",
        "/project",
      ),
    ).toEqual([
      { kind: "speaker", text: "あなた", seq: 1 },
      { kind: "text", text: "指示", seq: 1, seqLine: 0 },
      { kind: "text", text: "次の行", seq: 1, seqLine: 1 },
      { kind: "note", text: "画像 1 件", seq: 1 },
    ]);
  });
  it.each([
    [
      "Read",
      { file_path: "/project/src/a.ts" },
      null,
      "/conversations/c1/file?path=src%2Fa.ts&line=1",
    ],
    ["mcp__sukuna__issue_get", { number: 42 }, null, "/issues/42"],
    ["mcp__sukuna__issue_create", {}, '{"issue":{"id":"issue-id","number":43}}', "/issues/43"],
    ["mcp__sukuna__issue_list", {}, null, null],
  ])("%s の行は対象を開く先を決める", (name, input, result, target) => {
    const lines = eventLines(
      event(2, {
        type: "tool_use",
        payload: { tool_use_id: "tool-1", name, input, parent_tool_use_id: null },
      }),
      "c1",
      "/project",
      result,
    );
    expect(lines.map((line) => line.target?.url ?? null)).toEqual([target]);
  });
  it.each(
    ["create", "edit"].flatMap((change) =>
      [25, 26].map((count) => ({ change: change as "create" | "edit", count })),
    ),
  )("$change の差分が $count 行なら25行を超えたときだけ畳む", ({ change, count }) => {
    const diff = event(3, {
      type: "diff",
      payload: {
        tool_use_id: "tool-1",
        path: "a.ts",
        change,
        content: Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
        hunks:
          change === "create"
            ? []
            : [
                {
                  old_start: 1,
                  old_lines: 0,
                  new_start: 1,
                  new_lines: count,
                  lines: Array.from({ length: count }, (_, i) => `+line ${i + 1}`),
                },
              ],
        truncated: false,
      },
    });
    const lines = eventLines(diff, "c1", "/project");
    expect(lines.map((line) => line.text)).toEqual(
      count === 25
        ? Array.from({ length: count }, (_, i) => `${i + 1} +line ${i + 1}`)
        : [
            ...Array.from({ length: 10 }, (_, i) => `${i + 1} +line ${i + 1}`),
            "残り 16 行 (Enter か zo で開く)",
          ],
    );
    expect(eventLines(diff, "c1", "/project", null, true).length).toBe(count);
  });
  it.each([
    {
      name: "空",
      content: "",
      truncated: false,
      expected: [{ kind: "tool", text: "  ⎿  (出力なし)", seq: 4 }],
    },
    {
      name: "改行だけ",
      content: "\n\n",
      truncated: false,
      expected: [{ kind: "tool", text: "  ⎿  (出力なし)", seq: 4 }],
    },
    {
      name: "切り詰められた 5 行",
      content: "一\n二\n三\n四\n五",
      truncated: true,
      expected: [
        { kind: "tool", text: "  ⎿  一", seq: 4, seqLine: 0 },
        { kind: "tool", text: "     二", seq: 4, seqLine: 1 },
        { kind: "tool", text: "     三", seq: 4, seqLine: 2 },
        { kind: "tool", text: "     … +2 行以上", seq: 4 },
      ],
    },
  ])(
    "ツールの結果が $name のとき、その旨か残りの行数を添える",
    ({ content, truncated, expected }) => {
      const result = event(4, {
        type: "tool_result",
        payload: { tool_use_id: "t", is_error: false, content, truncated, bytes: 0 },
      });
      expect(eventLines(result, "c1", "/project")).toEqual(expected);
    },
  );
  it.each([
    {
      name: "文と保存できた画像と保存できなかった画像",
      content: "Took a screenshot.",
      images: ["01J0000000000000000000000A", "01J0000000000000000000000B"],
      omitted: 1,
      expected: [
        { kind: "tool", text: "  ⎿  Took a screenshot.", seq: 5, seqLine: 0 },
        {
          kind: "tool",
          text: "     画像 1 / 2 (Enter で元の大きさで開く)",
          seq: 5,
          image: {
            url: "/api/conversations/c1/images/01J0000000000000000000000A",
            alt: "画像 1 / 2",
          },
        },
        {
          kind: "tool",
          text: "     画像 2 / 2 (Enter で元の大きさで開く)",
          seq: 5,
          image: {
            url: "/api/conversations/c1/images/01J0000000000000000000000B",
            alt: "画像 2 / 2",
          },
        },
        { kind: "tool", text: "     画像 1 件は保存できなかったため表示できません", seq: 5 },
      ],
    },
    {
      name: "文が無く保存できた画像",
      content: "",
      images: ["01J0000000000000000000000A"],
      omitted: 0,
      expected: [
        { kind: "tool", text: "  ⎿  画像 1 件", seq: 5 },
        {
          kind: "tool",
          text: "     画像 1 / 1 (Enter で元の大きさで開く)",
          seq: 5,
          image: {
            url: "/api/conversations/c1/images/01J0000000000000000000000A",
            alt: "画像 1 / 1",
          },
        },
      ],
    },
    {
      name: "文が無く 1 枚も保存できなかった画像",
      content: "",
      images: [],
      omitted: 2,
      expected: [
        { kind: "tool", text: "  ⎿  画像 2 件 (表示できません)", seq: 5 },
        { kind: "tool", text: "     画像 2 件は保存できなかったため表示できません", seq: 5 },
      ],
    },
  ])(
    "ツールの結果が $name のとき、結果の行の下に画像の行を並べる",
    ({ content, images, omitted, expected }) => {
      const result = event(5, {
        type: "tool_result",
        payload: {
          tool_use_id: "t",
          is_error: false,
          content,
          truncated: false,
          bytes: 0,
          ...(images.length
            ? { images: images.map((id) => ({ id, media_type: "image/png" })) }
            : {}),
          ...(omitted ? { omitted_images: omitted } : {}),
        },
      });
      expect(eventLines(result, "c1", "/project")).toEqual(expected);
    },
  );
  it("切替一覧はプロジェクトごとに会話・対象 issue・開始メニューを並べ、現在のプロジェクトだけ worktree の開始を出す", () => {
    const projects = [
      {
        id: "p1",
        name: "one",
        conversations: [{ id: "c1", title: "会話" }],
        issues: ["draft", "done", "withdrawn", "ready"].map((state, i) => ({
          id: `i${i}`,
          number: i + 1,
          title: state,
          state,
        })),
      },
      { id: "p2", name: "two", conversations: [], issues: [] },
    ];
    expect(switchLines(projects, "p1").map((line) => line.text)).toEqual([
      "one",
      "会話: 会話",
      "#4 ready",
      "one で会話を始める",
      "worktree を作って会話を始める",
      "two",
      "two で会話を始める",
    ]);
  });
});
