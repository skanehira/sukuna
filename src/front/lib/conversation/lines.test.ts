import { describe, expect, it } from "vite-plus/test";
import { eventLines, switchLines } from "./lines";
import type { Event } from "./types";

const event = (seq: number, value: Omit<Event, "seq" | "createdAt">): Event => ({ ...value, seq, createdAt: 0 } as Event);
describe("会話の行", () => {
  it("発言は札と本文、画像の件数を順に並べる", () => {
    expect(eventLines(event(1, { type: "user_message", payload: { text: "指示\n次の行", images: [{ path: "image-1", media_type: "image/png" }], origin: "developer" } }), "c1", "/project")).toEqual([
      { kind: "speaker", text: "あなた", seq: 1 },
      { kind: "text", text: "指示", seq: 1, seqLine: 0 },
      { kind: "text", text: "次の行", seq: 1, seqLine: 1 },
      { kind: "note", text: "画像 1 件", seq: 1 },
    ]);
  });
  it.each([
    ["Read", { file_path: "/project/src/a.ts" }, null, "/conversations/c1/file?path=src%2Fa.ts&line=1"],
    ["mcp__sukuna__issue_get", { number: 42 }, null, "/issues/42"],
    ["mcp__sukuna__issue_create", {}, '{"issue":{"id":"issue-id","number":43}}', "/issues/issue-id"],
    ["mcp__sukuna__issue_list", {}, null, null],
  ])("%s の行は対象を開く先を決める", (name, input, result, target) => {
    const lines = eventLines(event(2, { type: "tool_use", payload: { tool_use_id: "tool-1", name, input, parent_tool_use_id: null } }), "c1", "/project", result);
    expect(lines.map((line) => line.target?.url ?? null)).toEqual([target]);
  });
  it.each([25, 26])("差分が %i 行なら 25 行を超えたときだけ先頭 10 行に畳む", (count) => {
    const diff = event(3, { type: "diff", payload: { tool_use_id: "tool-1", path: "a.ts", change: "edit", hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: count, lines: Array.from({ length: count }, (_, i) => `+line ${i + 1}`) }], truncated: false } });
    const lines = eventLines(diff, "c1", "/project");
    expect(lines.map((line) => line.text)).toEqual(count === 25 ? Array.from({ length: count }, (_, i) => `${i + 1} +line ${i + 1}`) : [...Array.from({ length: 10 }, (_, i) => `${i + 1} +line ${i + 1}`), "残り 16 行 (Enter か zo で開く)"]);
    expect(eventLines(diff, "c1", "/project", null, true).length).toBe(count);
  });
  it("切替一覧はプロジェクトごとに会話・対象 issue・開始メニューを並べ、現在のプロジェクトだけ worktree の開始を出す", () => {
    const projects = [{ id: "p1", name: "one", conversations: [{ id: "c1", title: "会話" }], issues: ["draft", "done", "withdrawn", "ready"].map((state, i) => ({ id: `i${i}`, number: i + 1, title: state, state })) }, { id: "p2", name: "two", conversations: [], issues: [] }];
    expect(switchLines(projects, "p1").map((line) => line.text)).toEqual(["one", "会話: 会話", "#4 ready", "one で会話を始める", "worktree を作って会話を始める", "two", "two で会話を始める"]);
  });
});
