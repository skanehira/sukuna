import type { IssueState } from "../../../../shared/issue/state";

export function parentClosing(state: IssueState, children: readonly IssueState[]) {
  const allClosed = children.every((child) => child === "done" || child === "withdrawn");
  if (state === "ready" && allClosed && children.includes("done")) return "children_closed";
  if (state === "done" && !allClosed) return "child_reopened";
  return null;
}
