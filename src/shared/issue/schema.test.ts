import { describe, expect, it } from "vite-plus/test";
import { issueInputSchema, issueListSchema, issueToolSchemas } from "./schema";

describe("issue の公開入力の境界", () => {
  it("一覧の既定は API が100件、AIが50件である", () => {
    expect(issueListSchema.parse({})).toEqual({ limit: 100 });
    expect(issueToolSchemas.issue_list.parse({})).toEqual({ limit: 50 });
  });
  it.each(["high", "medium", "low"] as const)(
    "下書きとAIの入力は優先度 %s を保存できる",
    (priority) => {
      expect(issueInputSchema.parse({ priority })).toEqual({ priority });
      expect(issueToolSchemas.issue_update.parse({ number: 1, priority })).toEqual({
        number: 1,
        priority,
      });
    },
  );
  it.each(["bug", "enhancement", "refactoring", "question"] as const)(
    "AIの入力は種別 %s と明示した設定を保持する",
    (kind) => {
      const input = {
        title: "題名",
        body: "",
        kind,
        priority: "low",
        parent: null,
        depends_on: [1, 1],
        confirm_before_merge: false,
        designed: true,
      };
      expect(issueToolSchemas.issue_create.parse(input)).toEqual({ ...input, depends_on: [1] });
    },
  );
  it.each([
    "draft",
    "triage",
    "design",
    "design_review",
    "ready",
    "implementing",
    "stopped",
    "done",
    "withdrawn",
  ] as const)("一覧で状態 %s を指定できる", (state) => {
    expect(issueListSchema.parse({ state: [state], limit: 500, cursor: 1, q: "語" })).toEqual({
      state: [state],
      limit: 500,
      cursor: 1,
      q: "語",
    });
    expect(issueToolSchemas.issue_list.parse({ state: [state], limit: 200, text: "語" })).toEqual({
      state: [state],
      limit: 200,
      text: "語",
    });
  });
  it("コメント・設計の方針・確認点の上限ちょうどは保持し、超えた値は断る", () => {
    const comment = { number: 1, text: "c".repeat(20000) };
    const design = {
      number: 1,
      policy: "p".repeat(20000),
      checks: Array.from({ length: 50 }, () => "c".repeat(2000)),
    };
    expect(issueToolSchemas.issue_comment.parse(comment)).toEqual(comment);
    expect(issueToolSchemas.report_design.parse(design)).toEqual(design);
    for (const input of [
      { ...design, policy: "p".repeat(20001) },
      { ...design, checks: Array.from({ length: 51 }, () => "c") },
      { ...design, checks: ["c".repeat(2001)] },
      { ...design, policy: "   " },
    ])
      expect(issueToolSchemas.report_design.safeParse(input).success).toBe(false);
    expect(
      issueToolSchemas.issue_comment.safeParse({ ...comment, text: "c".repeat(20001) }).success,
    ).toBe(false);
  });
  it("人への質問とCIの失敗は上限ちょうどを保持し、件数の超過や空を断る", () => {
    const questions = {
      number: 1,
      questions: Array.from({ length: 20 }, () => ({
        text: "q".repeat(2000),
        options: Array.from({ length: 10 }, () => "選択肢"),
      })),
      summary: "s".repeat(2000),
    };
    const ci = {
      number: 1,
      checks: Array.from({ length: 100 }, () => ({
        name: "test",
        bucket: "fail",
        link: "https://example.com/check",
      })),
      timed_out: true,
      summary: "s".repeat(2000),
    };
    expect(issueToolSchemas.report_needs_human.parse(questions)).toEqual(questions);
    expect(issueToolSchemas.report_ci_failed.parse(ci)).toEqual(ci);
    for (const input of [
      { ...questions, questions: [] },
      { ...questions, questions: [...questions.questions, questions.questions[0]!] },
      { ...questions, questions: [{ text: "q".repeat(2001) }] },
      {
        ...questions,
        questions: [{ text: "q", options: Array.from({ length: 11 }, () => "選択肢") }],
      },
      { ...questions, summary: "s".repeat(2001) },
    ])
      expect(issueToolSchemas.report_needs_human.safeParse(input).success).toBe(false);
    for (const input of [
      { ...ci, checks: [] },
      { ...ci, checks: [...ci.checks, ci.checks[0]!] },
      { ...ci, summary: "s".repeat(2001) },
    ])
      expect(issueToolSchemas.report_ci_failed.safeParse(input).success).toBe(false);
  });
  it.each(["fail", "cancel", "pending"] as const)("CI の結果 %s を受け付ける", (bucket) => {
    const input = { number: 1, checks: [{ name: "check", bucket }], timed_out: false, summary: "" };
    expect(issueToolSchemas.report_ci_failed.parse(input)).toEqual(input);
  });
  it.each(["review", "pr", "merge"] as const)("実装の段階 %s を受け付ける", (stage) => {
    expect(issueToolSchemas.report_stage.parse({ number: 1, stage })).toEqual({ number: 1, stage });
  });
  it.each([0, 1000])("精査スコア %s と要約の上限を保持する", (score) => {
    const input = {
      number: 1,
      result: "parent",
      kind: "question",
      urgent: true,
      score,
      summary: "s".repeat(2000),
    };
    expect(issueToolSchemas.report_triage.parse(input)).toEqual(input);
    expect(
      issueToolSchemas.report_triage.safeParse({ ...input, summary: "s".repeat(2001) }).success,
    ).toBe(false);
    expect(issueToolSchemas.report_triage.safeParse({ ...input, score: -1 }).success).toBe(false);
  });
});
