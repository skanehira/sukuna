import { objectOf } from "../../../../shared/activity/stage";
import { priorityRank } from "../../../../shared/inbox/order";
import type { OverviewResponse } from "../../../../shared/inbox/schema";
import type { IssueState } from "../../../../shared/issue/state";
import { issueActiveState, issueLastActivity } from "../domain/conversation";
import type { InboxDependencies, InboxIssue, InboxProject } from "../domain/ports";
import { refreshRow } from "./refresh-row";
const states: IssueState[] = [
  "stopped",
  "design_review",
  "implementing",
  "design",
  "triage",
  "ready",
  "draft",
  "done",
  "withdrawn",
];
export function buildOverview(
  project: InboxProject,
  deps: InboxDependencies,
  flowPaused: boolean,
  allClosed: boolean,
): OverviewResponse {
  return {
    project: { id: project.id, name: project.name, flowPaused: project.flowPaused },
    issueSections: states.flatMap((state) => {
      const closed = state === "done" || state === "withdrawn";
      const issues = project.issues
        .filter((i) => i.state === state)
        .sort((a, b) =>
          closed
            ? (b.closedAt ?? 0) - (a.closedAt ?? 0) || b.number - a.number
            : priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number,
        );
      if (issues.length === 0) return [];
      return [
        {
          state,
          total: issues.length,
          rows: (closed && !allClosed ? issues.slice(0, 10) : issues).map((issue) => {
            const row = refreshRow(project, issue, deps, flowPaused);
            const status = closed
              ? keptWorktreeStatus(issue, project)
              : state === "draft"
                ? "—"
                : state === "ready"
                  ? (row?.status ?? readyStatus(issue, project, flowPaused))
                  : (row?.status ?? "—");
            return {
              key: `issue:${issue.id}`,
              id: issue.id,
              number: issue.number,
              title: issue.title,
              status,
              lastActivityAt: issueLastActivity(issue, project),
              unread: row?.unread ?? false,
              activity: row?.activity ?? null,
            };
          }),
        },
      ];
    }),
    conversations: project.conversations
      .filter((c) => c.kind === "chat" && c.closedAt === null)
      .map((c) => ({ c, row: refreshRow(project, c, deps, flowPaused)! }))
      .sort((a, b) => b.row.lastActivityAt - a.row.lastActivityAt || (a.c.id < b.c.id ? 1 : -1))
      .map(({ c, row }) => ({
        key: row.key,
        id: c.id,
        title: c.title ?? "",
        status: row.status,
        lastActivityAt: row.lastActivityAt,
        unread: row.unread,
        activity: row.activity,
      })),
  };
}
function keptWorktreeStatus(issue: InboxIssue, project: InboxProject): string {
  const kept = issue.events
    .filter((e) => e.type === "worktree_kept")
    .map((e) =>
      project.worktrees.find(
        (w) => w.id === objectOf(e.payload).worktreeId && w.removedAt === null,
      ),
    )
    .findLast((w) => w !== undefined);
  return kept === undefined ? "—" : `worktree を残しました: ${kept.path}`;
}
function readyStatus(issue: InboxIssue, project: InboxProject, flowPaused: boolean): string {
  if (project.issues.some((i) => i.parentId === issue.id)) return "子の完了を待つ";
  const dependencies = project.dependencies
    .filter((d) => d.issueId === issue.id)
    .flatMap((d) => project.issues.filter((i) => i.id === d.dependsOnId && i.state !== "done"))
    .sort((a, b) => a.number - b.number);
  if (dependencies[0]) return `#${dependencies[0].number} の完了を待つ`;
  const parent = project.issues.find((i) => i.id === issue.parentId);
  if (
    parent &&
    (["design", "design_review"].includes(parent.state) ||
      (parent.state === "stopped" && issueActiveState(parent) === "design"))
  )
    return `親 #${parent.number} の設計を待つ`;
  if (flowPaused || project.flowPaused) return "自動フローを一時停止しています";
  if (!project.autoStages.includes("impl")) return "自動で処理しない段階です";
  return "実装の空きを待つ";
}
