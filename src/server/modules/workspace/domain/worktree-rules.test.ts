import { describe, expect, it } from "vite-plus/test";
import { defaultWorktreeName, validWorktreeName } from "./worktree-rules";

describe("開発者の worktree の名前", () => {
  it.each(["a", "Try_2.0-cache", "x".repeat(60)])("%s は規則を満たす", (name) => {
    expect(validWorktreeName(name)).toBe(true);
  });
  it.each([
    "",
    "x".repeat(61),
    ".try",
    "-try",
    "a/b",
    "a b",
    "日本語",
    "a.lock",
    "main",
    "sukuna",
    "issue-2",
    "design-3",
  ])("%s は使えない", (name) => {
    expect(validWorktreeName(name)).toBe(false);
  });
  it("省略名は同じ名前の worktree とブランチを避け、最小の連番を付ける", () => {
    const date = new Date(2026, 10, 27, 9, 5);
    expect(
      defaultWorktreeName(
        date,
        ["chat-20261127-0905", "chat-20261127-0905-3"],
        ["chat-20261127-0905-2"],
      ),
    ).toBe("chat-20261127-0905-4");
    expect(defaultWorktreeName(date, ["chat-20261127-0905", "chat-20261127-0905-2"], [])).toBe(
      "chat-20261127-0905-3",
    );
    expect(defaultWorktreeName(date, [], [])).toBe("chat-20261127-0905");
    expect(defaultWorktreeName(date, ["chat-20261127-0905", "chat-20261127-0905-3"], [])).toBe(
      "chat-20261127-0905-2",
    );
  });
});
