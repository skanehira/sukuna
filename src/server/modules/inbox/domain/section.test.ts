import { describe, expect, it } from "vite-plus/test";
import {
  conversationSection,
  issueSection,
  threadNeedsDecision,
  type ConversationFacts,
} from "./section";

const idle: ConversationFacts = {
  runState: "idle",
  stopReason: null,
  closedAt: null,
  pendingRecap: false,
  unansweredQuestions: 0,
  developerTurn: false,
};
const row = (section: string, reason: string) => ({ section, reason });
describe("一覧のセクション", () => {
  it.each([
    ["working", null, false, 0, row("working", "working")],
    ["waiting_answer", null, false, 0, row("decision", "question")],
    ["waiting_permission", null, false, 0, row("decision", "permission")],
    ["failed", "error", false, 0, row("decision", "failed")],
    ["usage_limited", "usage_limit", false, 0, row("decision", "usage_limited")],
    ["idle", null, true, 1, row("working", "summarizing")],
    ["idle", null, false, 1, row("decision", "question")],
    ["idle", null, false, 0, row("instruction", "turn_ended")],
    ["stopped", "user", false, 0, row("instruction", "stopped_by_user")],
    ["stopped", "restarted", false, 0, row("decision", "restarted")],
  ] as const)(
    "会話 %s/%s は契約のセクションと理由になる",
    (runState, stopReason, pendingRecap, unansweredQuestions, expected) => {
      expect(
        conversationSection(
          { ...idle, runState, stopReason, pendingRecap, unansweredQuestions },
          false,
        ),
      ).toEqual(expected);
    },
  );
  it("閉じた会話はスレッドが判断待ちでも載せず、開いた会話はスレッドを優先する", () => {
    expect([
      conversationSection({ ...idle, closedAt: 1 }, true),
      conversationSection({ ...idle, runState: "working" }, true),
    ]).toEqual([null, row("decision", "thread")]);
  });
  it.each([
    "question",
    "failed",
    "usage_limit",
    "ci_failed",
    "merge_confirm",
    "dependency_withdrawn",
  ] as const)("停止中の理由 %s をそのまま返す", (stopReason) => {
    expect(issueSection("stopped", stopReason, idle, true)).toEqual(row("decision", stopReason));
  });
  it("設計レビューの理由はスレッドより優先する", () => {
    expect(issueSection("design_review", null, idle, true)).toEqual(
      row("decision", "design_review"),
    );
  });
  it.each(["triage", "design", "implementing"] as const)("%s の担当会話を判定する", (state) => {
    expect([
      issueSection(state, null, { ...idle, runState: "waiting_permission" }, false),
      ...(["waiting_answer", "failed", "usage_limited", "working"] as const).map((runState) =>
        issueSection(state, null, { ...idle, runState }, false),
      ),
      issueSection(state, null, { ...idle, runState: "stopped", stopReason: "user" }, false),
      issueSection(state, null, { ...idle, developerTurn: true, pendingRecap: true }, false),
      issueSection(state, null, { ...idle, developerTurn: true, unansweredQuestions: 1 }, false),
      issueSection(state, null, idle, false),
      issueSection(state, null, { ...idle, runState: "stopped", stopReason: "restarted" }, false),
      issueSection(state, null, null, false),
      issueSection(state, null, idle, true),
    ]).toEqual([
      row("decision", "permission"),
      row("decision", "question"),
      row("decision", "failed"),
      row("decision", "usage_limited"),
      row("working", "working"),
      row("instruction", "stopped_by_user"),
      row("working", "summarizing"),
      row("instruction", "turn_ended"),
      row("working", "flow_waiting"),
      row("working", "flow_waiting"),
      row("working", "flow_waiting"),
      row("decision", "thread"),
    ]);
  });
  it.each(["draft", "ready", "done", "withdrawn"] as const)(
    "%s は判断待ちのスレッドがある場合だけ載る",
    (state) => {
      expect([
        issueSection(state, null, idle, false),
        issueSection(state, null, idle, true),
      ]).toEqual([null, row("decision", "thread")]);
    },
  );
  it("閉じたスレッドと idle の文章の質問はスレッドの判断待ちに含めない", () => {
    expect([
      threadNeedsDecision({ ...idle, runState: "waiting_answer", closedAt: 1 }),
      threadNeedsDecision({ ...idle, unansweredQuestions: 1 }),
      threadNeedsDecision({ ...idle, runState: "stopped", stopReason: "user" }),
      ...(["waiting_answer", "waiting_permission", "failed", "usage_limited"] as const).map(
        (runState) => threadNeedsDecision({ ...idle, runState }),
      ),
      threadNeedsDecision({ ...idle, runState: "stopped", stopReason: "restarted" }),
    ]).toEqual([false, false, false, true, true, true, true, true]);
  });
});
