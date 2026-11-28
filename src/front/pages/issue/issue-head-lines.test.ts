import { expect, it } from "vite-plus/test";
import { firstIssueConversation, issueFooterLines, issueHeadLines } from "./issue-head-lines";
import { issueView } from "./issue.test-support";

it("状態、親、番号順の子・依存、作成元と段階の選択を表示する", () => {
  const issue = issueView({
    state: "stopped",
    stopReason: "dependency_withdrawn",
    parent: { id: "p1", number: 1, title: "予約", state: "ready" },
    children: [
      { id: "c", number: 25, title: "取消", state: "triage" },
      { id: "b", number: 12, title: "登録", state: "draft" },
    ],
    dependsOn: [{ id: "d", number: 7, title: "在庫", state: "withdrawn" }],
    createdConversationId: "source",
    createdConversation: { id: "source", title: "予約を相談する", deleted: false },
    conversations: [
      { id: "i", kind: "impl", runState: "idle" },
      { id: "d", kind: "design", runState: "idle" },
      { id: "t", kind: "triage", runState: "idle" },
    ],
  });
  const lines = issueHeadLines(issue, "d");
  expect(lines.map(({ text }) => text)).toEqual([
    "状態  停止中 (依存先の取り下げ)",
    "親  #1 予約 (実装待ち)",
    "子  #12 登録 (下書き)",
    "  #25 取消 (精査待ち)",
    "依存先  #7 在庫 (取り下げ)",
    "作った会話  予約を相談する",
    "精査の会話",
    "設計の会話 (表示中)",
    "実装の会話",
    "",
  ]);
  expect(lines.flatMap(({ target }) => target?.url ?? [])).toEqual([
    "/issues/p1",
    "/issues/b",
    "/issues/c",
    "/issues/d",
    "/conversations/source",
  ]);
});

it("削除済みの作成元は案内だけを出す", () => {
  const issue = issueView({
    createdConversationId: "gone",
    createdConversation: { id: "gone", title: null, deleted: true },
  });
  expect(issueHeadLines(issue, undefined).find(({ id }) => id === "creator")).toEqual({
    id: "creator",
    kind: "pair",
    colDef: "issue-fields",
    cols: ["", "作った会話は削除されています"],
    text: "  作った会話は削除されています",
  });
});

it("停止前の担当を、あとから作った別段階の会話より優先する", () => {
  const issue = issueView({
    state: "stopped",
    stoppedFrom: "design",
    stopReason: "dependency_withdrawn",
    conversations: [
      { id: "d", kind: "design", runState: "idle" },
      { id: "i", kind: "impl", runState: "idle" },
    ],
  });
  expect(firstIssueConversation(issue)?.id).toBe("d");
  expect(firstIssueConversation({ ...issue, state: "withdrawn" })?.id).toBe("i");
});

const footer = (
  issue: Parameters<typeof issueFooterLines>[0],
  view?: Parameters<typeof issueFooterLines>[1],
) => issueFooterLines(issue, view).map(({ text }) => text);

it.each([
  {
    state: { stopReason: "question" } as const,
    expected: ["止まっています: AI が判断を求めています。この会話で答えると続きます"],
  },
  {
    state: { stopReason: "failed" } as const,
    expected: ["止まっています: #30。指示を送ると続きます"],
  },
  {
    state: { stopReason: "ci_failed" } as const,
    expected: [
      "止まっています: CI が失敗しました (#30)。指示を送ると AI が直します",
      "差分の表示で CI を見る",
    ],
  },
  {
    state: { stopReason: "merge_confirm" } as const,
    expected: ["merge 前の確認を待っています", "差分の表示で確かめる"],
  },
  {
    state: { stopReason: "dependency_withdrawn" } as const,
    expected: [
      "止まっています: 依存先 #30 が取り下げられました。依存を外すか、依存先を再開すると続きます",
      "依存を直す  編集の画面を開く",
    ],
  },
])("停止理由 $state.stopReason に対応する案内を表示する", ({ state, expected }) => {
  const issue = issueView({ state: "stopped", stopDetail: "#30", ...state });
  expect(footer(issue)).toEqual(expected);
});

it("質問・worktree の失敗・会話停止に専用行があれば重ねず、会話のない失敗は表示する", () => {
  const base = issueView({ state: "stopped", stopReason: "failed", stopDetail: "接続に失敗" });
  expect(footer(base)).toEqual(["止まっています: 接続に失敗。指示を送ると続きます"]);
  expect(footer(base, { conversationStopped: true })).toEqual([]);
  expect(footer({ ...base, stopCause: "worktree_failed" })).toEqual([]);
  const question = { ...base, stopReason: "question" as const };
  expect(footer(question)).toEqual([
    "止まっています: AI が判断を求めています。この会話で答えると続きます",
  ]);
  expect(footer(question, { hasQuestion: true })).toEqual([]);
});

it("完了と取り下げの理由、残した worktree、開いたままの PR と再開を表示する", () => {
  const issue = issueView({
    state: "withdrawn",
    prUrl: "https://github.com/example/project/pull/1",
    keptWorktreePath: "/tmp/keep",
  });
  expect(footer(issue)).toEqual([
    "この issue は取り下げられています",
    "PR https://github.com/example/project/pull/1 は開いたままです",
    "worktree を残しました: /tmp/keep",
    "この issue を再開する  精査からやり直す",
  ]);
  expect(footer({ ...issue, state: "done" })).toEqual([
    "この issue は完了しています",
    "worktree を残しました: /tmp/keep",
    "この issue を再開する  精査からやり直す",
  ]);
});
