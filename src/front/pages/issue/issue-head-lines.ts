import type { IssueReference, IssueView } from "../../../shared/issue/schema";
import type { IssueState, IssueStopReason } from "../../../shared/issue/state";
import type { LineInfo } from "../../buffer/line";
import { issuePair } from "./issue-form-lines";

export const issueDisplays = ["conversation", "design", "diff"] as const;
export type IssueDisplay = (typeof issueDisplays)[number];
export const displayLabels = { conversation: "会話", design: "設計", diff: "差分" };
export const stageLabels = { triage: "精査", design: "設計", impl: "実装" };
type Stage = keyof typeof stageLabels;
type IssueConversation = IssueView["conversations"][number];

const stateNames: Record<IssueState, string> = {
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
const stopNames: Record<IssueStopReason, string> = {
  question: "AI の質問",
  failed: "失敗",
  usage_limit: "利用枠切れ",
  ci_failed: "CI の失敗",
  merge_confirm: "merge 前の確認",
  dependency_withdrawn: "依存先の取り下げ",
};

export function firstIssueDisplay(issue: IssueView): IssueDisplay {
  if (issue.state === "design_review") return "design";
  if (issue.state === "stopped" && issue.stopReason === "merge_confirm") return "diff";
  return "conversation";
}

export function issueConversations(issue: IssueView): IssueConversation[] {
  return (Object.keys(stageLabels) as Stage[])
    .map((kind) => issue.conversations.findLast((item) => item.kind === kind))
    .filter((item) => item !== undefined);
}

export function firstIssueConversation(issue: IssueView): IssueConversation | undefined {
  const active = issue.state === "stopped" ? issue.stoppedFrom : issue.state;
  const kind =
    active === "triage"
      ? "triage"
      : active === "design" || active === "design_review"
        ? "design"
        : active === "ready" || active === "implementing" || active === "done"
          ? "impl"
          : undefined;
  return issue.conversations.findLast((item) => item.kind === kind) ?? issue.conversations.at(-1);
}

function issueLink(label: string, item: IssueReference, group: string) {
  return {
    ...issuePair(
      `${group}:${item.id}`,
      label,
      `#${item.number} ${item.title} (${stateNames[item.state]})`,
    ),
    target: { url: `/issues/${encodeURIComponent(item.id)}` },
  };
}

export function issueHeadLines(issue: IssueView, selected: string | undefined): LineInfo[] {
  const { state, stopReason, parent, createdConversation } = issue;
  const status =
    state === "stopped" && stopReason
      ? `${stateNames[state]} (${stopNames[stopReason]})`
      : stateNames[state];
  return [
    issuePair("state", "状態", status),
    ...(parent ? [issueLink("親", parent, "parent")] : []),
    ...[...issue.children]
      .sort((a, b) => a.number - b.number)
      .map((item, index) => issueLink(index === 0 ? "子" : "", item, "child")),
    ...[...issue.dependsOn]
      .sort((a, b) => a.number - b.number)
      .map((item, index) => issueLink(index === 0 ? "依存先" : "", item, "dependency")),
    ...(createdConversation
      ? [
          createdConversation.deleted
            ? issuePair("creator", "", "作った会話は削除されています")
            : {
                ...issuePair("creator", "作った会話", createdConversation.title ?? ""),
                target: { url: `/conversations/${encodeURIComponent(createdConversation.id)}` },
              },
        ]
      : []),
    ...issueConversations(issue).map(({ id, kind }): LineInfo => ({
      kind: "menu",
      id: `stage:${kind}`,
      action: `issue.conversation.${kind}`,
      text: `${stageLabels[kind]}の会話${id === selected ? " (表示中)" : ""}`,
      done: id === selected,
    })),
    { kind: "separator", text: "" },
  ];
}

function issueOperation(text: string, action: string, description?: string): LineInfo {
  return {
    kind: "menu",
    id: action,
    action,
    text: description ? `${text}  ${description}` : text,
    ...(description ? { cols: [text, description] } : {}),
  };
}

export function issueFooterLines(
  issue: IssueView,
  { hasQuestion = false, conversationStopped = false } = {},
): LineInfo[] {
  const detail = issue.stopDetail;
  const note = (id: string, text: string): LineInfo => ({ id, kind: "note", text });
  const stopLine = (text: string) => note("issue-stop", text);
  if (issue.state === "done" || issue.state === "withdrawn") {
    const withdrawn = issue.state === "withdrawn";
    return [
      stopLine(withdrawn ? "この issue は取り下げられています" : "この issue は完了しています"),
      ...(withdrawn && issue.prUrl ? [note("issue-pr", `PR ${issue.prUrl} は開いたままです`)] : []),
      ...(issue.keptWorktreePath
        ? [note("issue-worktree", `worktree を残しました: ${issue.keptWorktreePath}`)]
        : []),
      issueOperation("この issue を再開する", "issue.reopen", "精査からやり直す"),
    ];
  }
  if (issue.state !== "stopped") return [];
  switch (issue.stopReason) {
    case "question":
      return hasQuestion
        ? []
        : [stopLine("止まっています: AI が判断を求めています。この会話で答えると続きます")];
    case "failed":
      return issue.stopCause === "worktree_failed" || conversationStopped
        ? []
        : [stopLine(`止まっています: ${detail ?? "失敗しました"}。指示を送ると続きます`)];
    case "ci_failed":
      return [
        stopLine(`止まっています: CI が失敗しました (${detail ?? ""})。指示を送ると AI が直します`),
        issueOperation("差分の表示で CI を見る", "issue.diff"),
      ];
    case "merge_confirm":
      return [
        stopLine("merge 前の確認を待っています"),
        issueOperation("差分の表示で確かめる", "issue.diff"),
      ];
    case "dependency_withdrawn":
      return [
        stopLine(
          `止まっています: 依存先 ${detail ?? ""} が取り下げられました。依存を外すか、依存先を再開すると続きます`,
        ),
        issueOperation("依存を直す", "issue.edit", "編集の画面を開く"),
      ];
    default:
      return [];
  }
}
