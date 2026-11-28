import { describe, expect, it } from "vitest";
import { formatLastAction, lastActionInTurn, turnProgress } from "./last-action";

describe("最後にしたこと", () => {
  it.each<[string, unknown, string]>([
    ["Bash", { command: "npm test -- csv\necho next" }, "Bash(npm test -- csv)"],
    ...["Read", "Edit", "Write"].map((name): [string, unknown, string] => [
      name,
      { file_path: "/work/src/a.ts" },
      `${name}(src/a.ts)`,
    ]),
    ["NotebookEdit", { notebook_path: "/work/book.ipynb" }, "NotebookEdit(book.ipynb)"],
    ["Read", { file_path: "/other/a.ts" }, "Read(../other/a.ts)"],
    ["Grep", { pattern: "needle" }, "Grep(needle)"],
    ["Glob", { pattern: "**/*.ts" }, "Glob(**/*.ts)"],
    ["WebFetch", { url: "https://example.com" }, "WebFetch(https://example.com)"],
    ["Task", { description: "調査" }, "Task(調査)"],
    ["Agent", { description: "検査" }, "Agent(検査)"],
    ["mcp__context7__query_docs", { query: "secret" }, "query_docs"],
    ["Unknown", {}, "Unknown"],
  ])("%s の対象を表示する", (name, input, expected) => {
    expect(formatLastAction(name, input, "/work")).toBe(expected);
  });

  it.each([60, 61])("%i 字の実行を 60 字で切り詰める", (length) => {
    expect(formatLastAction("あ".repeat(length), {}, "/work")).toBe(
      length === 60 ? "あ".repeat(60) : `${"あ".repeat(60)}…`,
    );
  });

  it("今の番より前のツールを除き最後の実行を返す", () => {
    const events = [
      {
        seq: 1,
        type: "tool_use",
        payload: { name: "Read", input: { file_path: "/work/old" } },
        createdAt: 1,
      },
      { seq: 2, type: "user_message", payload: {}, createdAt: 2 },
      {
        seq: 3,
        type: "tool_use",
        payload: { name: "Bash", input: { command: "npm test" } },
        createdAt: 3,
      },
    ];
    expect(lastActionInTurn(events, "/work")).toEqual({
      lastAction: "Bash(npm test)",
      lastActionAt: 3,
      turnStartedAt: 2,
    });
    expect(
      lastActionInTurn(
        [...events, { seq: 4, type: "user_message", payload: {}, createdAt: 4 }],
        "/work",
      ),
    ).toEqual({ lastAction: "応答を作成中", lastActionAt: null, turnStartedAt: 4 });
  });
});

it.each([
  ["mcp__server__nested__tool", {}, "/work", "nested__tool"],
  ["Read", { file_path: "src/a.ts" }, "/work", "Read(src/a.ts)"],
  ["Read", { file_path: "/work" }, "/work", "Read(.)"],
  ["Read", { file_path: "/a" }, "/", "Read(a)"],
  ["Bash", { command: 123 }, "/work", "Bash"],
  ["Bash", null, "/work", "Bash"],
  ["Unknown", { description: "対象ではない" }, "/work", "Unknown"],
] as const)("%s の省略・型の違う入力・相対パスを表示する", (name, input, cwd, expected) => {
  expect(formatLastAction(name, input, cwd)).toBe(expected);
});
it("発言前から記録されたツールも開始時刻ゼロで表示する", () => {
  expect(
    lastActionInTurn(
      [
        {
          seq: 1,
          type: "tool_use",
          payload: { name: "Bash", input: { command: "pwd" } },
          createdAt: 20,
        },
      ],
      "/work",
    ),
  ).toEqual({ lastAction: "Bash(pwd)", lastActionAt: 20, turnStartedAt: 0 });
});

const turnEvent = (seq: number, type: string, payload: unknown = {}) => ({
  seq,
  type,
  payload,
  createdAt: seq * 1000,
});
const toolUse = (seq: number, id: string, parent: string | null = null) =>
  turnEvent(seq, "tool_use", { tool_use_id: id, name: "Bash", parent_tool_use_id: parent });
const toolResult = (seq: number, id: string) =>
  turnEvent(seq, "tool_result", { tool_use_id: id, parent_tool_use_id: null });

describe("番の経過の起点と動き", () => {
  it.each(["user_message", "resumed", "answer", "permission_decision"])(
    "%s を受けた時刻から番の経過を数える",
    (type) => {
      expect(
        turnProgress([turnEvent(1, "user_message"), turnEvent(2, type), turnEvent(3, "tool_use")]),
      ).toEqual({ action: "考え中", startedAt: 2000 });
    },
  );

  it("起点のイベントがまだ無ければ番の経過の起点を持たない", () => {
    expect(turnProgress([turnEvent(1, "assistant_text")])).toEqual({
      action: "考え中",
      startedAt: null,
    });
  });

  it.each([
    ["結果の届いていない親のツールの実行がある", [toolUse(2, "a")], "ツールを実行中"],
    ["親のツールの実行の結果が届いた", [toolUse(2, "a"), toolResult(3, "a")], "考え中"],
    [
      "結果の届いていないサブエージェントのツールの実行だけがある",
      [toolUse(2, "a", "task")],
      "考え中",
    ],
    [
      "許可の確認に答えた後も結果の届いていないツールの実行がある",
      [toolUse(2, "a"), turnEvent(3, "permission_decision")],
      "ツールを実行中",
    ],
  ])("%s 番の動きを %s にする", (_, events, action) => {
    expect(turnProgress([turnEvent(1, "user_message"), ...events]).action).toBe(action);
  });

  it("前の番で結果の届かなかったツールの実行は、今の番の動きに数えない", () => {
    expect(turnProgress([toolUse(1, "old"), turnEvent(2, "user_message")])).toEqual({
      action: "考え中",
      startedAt: 2000,
    });
  });
});
