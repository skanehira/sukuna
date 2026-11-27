import { describe, expect, it } from "vitest";
import { formatLastAction, lastActionInTurn } from "./last-action";

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
