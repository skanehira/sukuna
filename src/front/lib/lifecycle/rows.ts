import type { RunState } from "../../../shared/events";
import { formatElapsed } from "../../../shared/inbox/elapsed";
import type { IssueState } from "../../../shared/issue/state";
import type { ColumnDef, LineInfo } from "../../buffer/line";
import { routeUrl } from "../routes";
import type { ListedConversation, ProjectList, SearchResult } from "./api";

const runLabels: Record<RunState, string> = {
  idle: "指示待ち",
  working: "作業中",
  waiting_answer: "判断待ち",
  waiting_permission: "判断待ち",
  stopped: "止まった",
  failed: "失敗",
  usage_limited: "利用枠切れ",
};

const issueLabels: Record<IssueState, string> = {
  draft: "下書き",
  triage: "精査待ち",
  design: "設計待ち",
  design_review: "設計レビュー",
  ready: "実装待ち",
  implementing: "実装中",
  stopped: "停止中",
  done: "完了",
  withdrawn: "取り下げ",
};

export const lifecycleColumns: ColumnDef[] = [
  {
    name: "lifecycle",
    heads: ["題名", "状況", "プロジェクト", "経過"],
    widths: [22, 22, 8, 5],
    align: ["left", "left", "left", "right"],
    classes: ["", "text-muted text-[13px]", "text-muted text-[13px]", "text-muted text-[12px]"],
  },
];

type RowSource = { id: string; title: string; lastActivityAt: number };
type ChatRow = RowSource & {
  kind: "chat";
  parentId?: never;
  closedAt: number | null;
  runState: RunState;
};
type ThreadRow = RowSource & {
  kind: "thread";
  parentId?: string;
  closedAt: number | null;
  runState: RunState;
};
type IssueRow = RowSource & { kind: "issue"; number: number; state?: IssueState };
export type LifecycleRow = ChatRow | ThreadRow | IssueRow;
type Group = (ChatRow | IssueRow) & { projectName: string; threads: ThreadRow[] };

export function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

export function issueUrl(id: string, state?: string): string {
  return routeUrl({ kind: "issue", id, view: state === "draft" ? "edit" : undefined });
}

export function conversationUrl(id: string, thread?: string): string {
  return routeUrl({ kind: "conversation", id, thread });
}

function sortedThreads(threads: ListedConversation[], parentId?: string): ThreadRow[] {
  return threads
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((thread) => ({
      ...thread,
      kind: "thread",
      parentId,
    }));
}

export function groupsForProjects(projects: ProjectList[]): Group[] {
  const groups = projects.flatMap(({ project, listing }): Group[] => [
    ...listing.conversations.map((conversation): Group => ({
      ...conversation,
      kind: "chat",
      projectName: project.name,
      threads: sortedThreads(conversation.threads, conversation.id),
    })),
    ...listing.issueThreads.flatMap(({ issue, threads }): Group[] => {
      if (threads.length === 0) return [];
      const state = project.issues.find((entry) => entry.id === issue.id)?.state as
        | IssueState
        | undefined;
      return [
        {
          ...issue,
          kind: "issue",
          state,
          projectName: project.name,
          lastActivityAt: threads.reduce(
            (latest, thread) => Math.max(latest, thread.lastActivityAt),
            -Infinity,
          ),
          threads: sortedThreads(threads),
        },
      ];
    }),
  ]);
  return groups.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id));
}

export function lifecycleRowId(row: LifecycleRow): string {
  return row.kind + ":" + row.id;
}

export function lifecycleLine(
  row: LifecycleRow,
  project: string,
  now: number,
  indent = false,
): LineInfo {
  const rowTitle =
    row.kind === "issue"
      ? ["#", row.number, " ", row.title].join("")
      : (row.kind === "chat" ? "会話: " : "スレッド: ") + row.title;
  const status =
    row.kind === "issue"
      ? row.state === undefined
        ? ""
        : issueLabels[row.state]
      : row.closedAt !== null
        ? row.kind === "chat"
          ? "閉じた"
          : "終了"
        : runLabels[row.runState];
  const cols = [
    (indent ? "  " : "") + singleLine(rowTitle),
    status ?? "",
    singleLine(project),
    formatElapsed(row.lastActivityAt, { now: () => now }),
  ];
  const url =
    row.kind === "issue"
      ? issueUrl(row.id, row.state)
      : row.kind === "chat"
        ? conversationUrl(row.id)
        : row.parentId
          ? conversationUrl(row.parentId, row.id)
          : null;
  return {
    kind: "row",
    id: lifecycleRowId(row),
    text: cols.join("  "),
    cols,
    colDef: "lifecycle",
    ...(url ? { target: { url } } : { action: "lifecycle.open-thread" }),
  };
}

export function searchLines(
  results: SearchResult[],
  projects: { id: string; name: string }[],
  now: number,
): LineInfo[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return results.map((result) => {
    const row: LifecycleRow = result.type === "issue" ? { ...result, kind: "issue" } : result;
    return lifecycleLine(row, names.get(result.projectId) ?? "", now);
  });
}
