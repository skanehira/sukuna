import { expect, it } from "vite-plus/test";
import type { IssueState } from "../../../../shared/issue/state";
import { parentClosing } from "./parent-closing";

it.each([
  ["ready", ["done", "withdrawn"], "children_closed"],
  ["ready", ["withdrawn"], null],
  ["done", ["ready"], "child_reopened"],
  ["design", ["done"], null],
] as const)("親が %s、子が %j のとき", (state, children, expected) => {
  expect(parentClosing(state, children as readonly IssueState[])).toBe(expected);
});
