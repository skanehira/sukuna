import { describe, expect, it } from "vite-plus/test";
import type { IssueState, IssueStopReason, StateChangeCause } from "../../../../shared/issue/state";
import {
  transition,
  type Transition,
  type TransitionContext,
  type TransitionTrigger,
} from "./transition";

type Example = {
  name: string;
  states: (IssueState | null)[];
  trigger: TransitionTrigger;
  context?: Partial<TransitionContext>;
  to: IssueState;
  reason?: IssueStopReason;
  cause: StateChangeCause | null;
};

const rows: Example[] = [
  { name: "01 開発者の作成", states: [null], trigger: "create_draft", to: "draft", cause: null },
  {
    name: "02 AI の作成",
    states: [null],
    trigger: "ai_created",
    to: "triage",
    cause: "ai_created",
  },
  {
    name: "03 下書きの確定",
    states: ["draft"],
    trigger: "confirm",
    to: "triage",
    cause: "confirm",
  },
  {
    name: "04 未設計の精査完了",
    states: ["triage"],
    trigger: "triage_reported",
    context: { triageResult: "design" },
    to: "design",
    cause: "triage_reported",
  },
  {
    name: "05 設計済みの精査完了",
    states: ["triage"],
    trigger: "triage_reported",
    context: { triageResult: "design", designed: true },
    to: "ready",
    cause: "triage_reported",
  },
  {
    name: "06 子を持つ精査完了",
    states: ["triage"],
    trigger: "triage_reported",
    context: { hasChildren: true, triageResult: "parent" },
    to: "ready",
    cause: "triage_reported",
  },
  {
    name: "07 精査と設計で判断を求める",
    states: ["triage", "design"],
    trigger: "needs_human",
    to: "stopped",
    reason: "question",
    cause: "needs_human",
  },
  {
    name: "08 精査と設計で選択式の回答を待つ",
    states: ["triage", "design"],
    trigger: "agent_question",
    to: "stopped",
    reason: "question",
    cause: "agent_question",
  },
  {
    name: "09 精査と設計で失敗",
    states: ["triage", "design"],
    trigger: "agent_failed",
    to: "stopped",
    reason: "failed",
    cause: "agent_failed",
  },
  {
    name: "10 精査と設計で報告が無い",
    states: ["triage", "design"],
    trigger: "no_report",
    to: "stopped",
    reason: "failed",
    cause: "no_report",
  },
  {
    name: "11 設計の worktree の失敗",
    states: ["design"],
    trigger: "worktree_failed",
    to: "stopped",
    reason: "failed",
    cause: "worktree_failed",
  },
  {
    name: "12 精査と設計の枠切れ",
    states: ["triage", "design"],
    trigger: "agent_usage_limit",
    to: "stopped",
    reason: "usage_limit",
    cause: "agent_usage_limit",
  },
  {
    name: "13 設計の提出",
    states: ["design"],
    trigger: "design_submitted",
    to: "design_review",
    cause: "design_submitted",
  },
  {
    name: "14 設計 PR の merge 完了",
    states: ["design"],
    trigger: "design_reflected",
    context: { designPrMergePending: true },
    to: "ready",
    cause: "design_reflected",
  },
  {
    name: "15 設計 PR が merge されていない",
    states: ["design"],
    trigger: "design_pr_not_merged",
    context: { designPrMergePending: true },
    to: "stopped",
    reason: "failed",
    cause: "design_pr_not_merged",
  },
  {
    name: "16 子の無い設計の反映",
    states: ["design_review"],
    trigger: "design_reflected",
    to: "ready",
    cause: "design_reflected",
  },
  {
    name: "17 子のある設計の反映",
    states: ["design_review"],
    trigger: "design_reflected",
    context: { hasChildren: true },
    to: "ready",
    cause: "design_reflected",
  },
  {
    name: "18 設計 PR の作成",
    states: ["design_review"],
    trigger: "design_pr_created",
    to: "design",
    cause: "design_pr_created",
  },
  {
    name: "19 設計の差し戻し",
    states: ["design_review"],
    trigger: "design_rejected",
    to: "design",
    cause: "design_rejected",
  },
  {
    name: "20 設計の反映失敗",
    states: ["design_review"],
    trigger: "design_reflect_failed",
    to: "design_review",
    cause: null,
  },
  {
    name: "21 実装の開始",
    states: ["ready"],
    trigger: "impl_started",
    context: { dependenciesDone: true, hasCapacity: true, stageEnabled: true },
    to: "implementing",
    cause: "impl_started",
  },
  {
    name: "22 実装で判断を求める",
    states: ["implementing"],
    trigger: "needs_human",
    to: "stopped",
    reason: "question",
    cause: "needs_human",
  },
  {
    name: "23 実装で選択式の回答を待つ",
    states: ["implementing"],
    trigger: "agent_question",
    to: "stopped",
    reason: "question",
    cause: "agent_question",
  },
  {
    name: "24 実装で失敗",
    states: ["implementing"],
    trigger: "agent_failed",
    to: "stopped",
    reason: "failed",
    cause: "agent_failed",
  },
  {
    name: "25 実装で報告が無い",
    states: ["implementing"],
    trigger: "no_report",
    to: "stopped",
    reason: "failed",
    cause: "no_report",
  },
  {
    name: "26 実装の worktree の失敗",
    states: ["implementing"],
    trigger: "worktree_failed",
    to: "stopped",
    reason: "failed",
    cause: "worktree_failed",
  },
  {
    name: "27 実装の枠切れ",
    states: ["implementing"],
    trigger: "agent_usage_limit",
    to: "stopped",
    reason: "usage_limit",
    cause: "agent_usage_limit",
  },
  {
    name: "28 CI の失敗",
    states: ["implementing"],
    trigger: "ci_failed",
    to: "stopped",
    reason: "ci_failed",
    cause: "ci_failed",
  },
  {
    name: "29 merge 前の確認",
    states: ["implementing"],
    trigger: "ready_for_merge",
    context: { confirmBeforeMerge: true },
    to: "stopped",
    reason: "merge_confirm",
    cause: "ready_for_merge",
  },
  {
    name: "30 AI の merge の報告を検証",
    states: ["implementing"],
    trigger: "implementation_done",
    context: { mergeVerified: true },
    to: "done",
    cause: "implementation_done",
  },
  {
    name: "31 GitHub での merge を検証",
    states: ["implementing", "stopped"],
    trigger: "implementation_done",
    context: {
      mergeVerified: true,
      mergeSource: "github",
      stoppedFrom: "implementing",
      stopReason: "ci_failed",
    },
    to: "done",
    cause: "implementation_done",
  },
  {
    name: "32 merge の許可",
    states: ["stopped"],
    trigger: "merge_allowed",
    context: { stopReason: "merge_confirm", stoppedFrom: "implementing" },
    to: "implementing",
    cause: "merge_allowed",
  },
  {
    name: "33 merge 前の指示",
    states: ["stopped"],
    trigger: "impl_instruction",
    context: { stopReason: "merge_confirm", stoppedFrom: "implementing" },
    to: "implementing",
    cause: "impl_instruction",
  },
  {
    name: "34 CI 失敗後の指示",
    states: ["stopped"],
    trigger: "impl_instruction",
    context: { stopReason: "ci_failed", stoppedFrom: "implementing" },
    to: "implementing",
    cause: "impl_instruction",
  },
  {
    name: "35 回答と再開",
    states: ["stopped"],
    trigger: "agent_resumed",
    context: { stopReason: "question", stoppedFrom: "design" },
    to: "design",
    cause: "agent_resumed",
  },
  {
    name: "36 worktree の作り直しに成功",
    states: ["stopped"],
    trigger: "agent_resumed",
    context: {
      stopReason: "failed",
      stoppedFrom: "design",
      stoppedCause: "worktree_failed",
      worktreeReady: true,
    },
    to: "design",
    cause: "agent_resumed",
  },
  {
    name: "37 worktree の作り直しに失敗",
    states: ["stopped"],
    trigger: "worktree_failed",
    context: { stopReason: "failed", stoppedFrom: "design", stoppedCause: "worktree_failed" },
    to: "stopped",
    reason: "failed",
    cause: "worktree_failed",
  },
  {
    name: "38 戻るときに取り下げの依存先が残る",
    states: ["stopped"],
    trigger: "dependency_withdrawn",
    context: { stopReason: "question", stoppedFrom: "triage", hasWithdrawnDependencies: true },
    to: "stopped",
    reason: "dependency_withdrawn",
    cause: "dependency_withdrawn",
  },
  {
    name: "39 依存先の取り下げの解消",
    states: ["stopped"],
    trigger: "dependency_cleared",
    context: { stopReason: "dependency_withdrawn", stoppedFrom: "design_review" },
    to: "design_review",
    cause: "dependency_cleared",
  },
  {
    name: "40 完了後の直し",
    states: ["done"],
    trigger: "reopened_for_fix",
    to: "implementing",
    cause: "reopened_for_fix",
  },
  {
    name: "41 開発者の取り下げ",
    states: ["draft", "triage", "design", "design_review", "ready", "implementing", "stopped"],
    trigger: "withdraw",
    to: "withdrawn",
    cause: "withdraw",
  },
  {
    name: "42 依存先の取り下げ",
    states: ["triage", "design", "design_review", "ready", "implementing"],
    trigger: "dependency_withdrawn",
    context: { hasWithdrawnDependencies: true },
    to: "stopped",
    reason: "dependency_withdrawn",
    cause: "dependency_withdrawn",
  },
  {
    name: "43 開始の評価で依存先の取り下げを発見",
    states: ["triage", "design", "ready"],
    trigger: "dependency_withdrawn",
    context: { hasWithdrawnDependencies: true },
    to: "stopped",
    reason: "dependency_withdrawn",
    cause: "dependency_withdrawn",
  },
  {
    name: "44 再起動前から質問の回答を待つ",
    states: ["triage", "design", "implementing"],
    trigger: "restart_question",
    to: "stopped",
    reason: "question",
    cause: "restart_question",
  },
  {
    name: "45 閉じた issue の再開",
    states: ["done", "withdrawn"],
    trigger: "reopen",
    to: "triage",
    cause: "reopen",
  },
  {
    name: "46 親の子が閉じた",
    states: ["ready"],
    trigger: "children_closed",
    context: { hasChildren: true, allChildrenClosed: true, hasDoneChild: true },
    to: "done",
    cause: "children_closed",
  },
  {
    name: "47 親の子が再開した",
    states: ["done"],
    trigger: "child_reopened",
    context: { hasChildren: true },
    to: "ready",
    cause: "child_reopened",
  },
];

describe("設計書の状態の移り変わりの表 (47 行)", () => {
  it.each(rows)("$name のとき、移った先と理由と cause が表のとおりになる", (row) => {
    for (const state of row.states) {
      const context = { state, ...row.context };

      expect(transition(context, row.trigger)).toEqual({
        from: state === "stopped" && row.to === "stopped" ? row.context?.stoppedFrom : state,
        to: row.to,
        stopReason: row.reason ?? null,
        cause: row.cause,
      });
    }
  });
});

describe("精査の結果より子の有無を優先する境界", () => {
  it.each([
    {
      name: "未設計の親が設計へ進むと報告しても実装待ちになる",
      hasChildren: true,
      designed: false,
      triageResult: "design",
      expected: { from: "triage", to: "ready", stopReason: null, cause: "triage_reported" },
    },
    {
      name: "設計済みの親が設計へ進むと報告しても実装待ちになる",
      hasChildren: true,
      designed: true,
      triageResult: "design",
      expected: { from: "triage", to: "ready", stopReason: null, cause: "triage_reported" },
    },
    {
      name: "設計済みの親が親と報告すると実装待ちになる",
      hasChildren: true,
      designed: true,
      triageResult: "parent",
      expected: { from: "triage", to: "ready", stopReason: null, cause: "triage_reported" },
    },
    {
      name: "設計済みでも子の無い issue が親と報告したら移さない",
      hasChildren: false,
      designed: true,
      triageResult: "parent",
      expected: null,
    },
  ] satisfies {
    name: string;
    hasChildren: boolean;
    designed: boolean;
    triageResult: "design" | "parent";
    expected: Transition | null;
  }[])("$name", ({ hasChildren, designed, triageResult, expected }) => {
    expect(
      transition({ state: "triage", hasChildren, designed, triageResult }, "triage_reported"),
    ).toEqual(expected);
  });
});

describe("GitHub の merge の起点と検証の境界", () => {
  it.each([
    {
      name: "停止履歴の無い実装中でも GitHub の merge を確認できれば完了する",
      context: { state: "implementing", mergeSource: "github", mergeVerified: true },
      expected: {
        from: "implementing",
        to: "done",
        stopReason: null,
        cause: "implementation_done",
      },
    },
    {
      name: "実装の CI 失敗で停止中でも未検証の GitHub merge では完了しない",
      context: {
        state: "stopped",
        stoppedFrom: "implementing",
        stopReason: "ci_failed",
        stoppedCause: "ci_failed",
        mergeSource: "github",
        mergeVerified: false,
      },
      expected: null,
    },
    {
      name: "実装の CI 失敗で停止中は AI の merge 報告では完了しない",
      context: {
        state: "stopped",
        stoppedFrom: "implementing",
        stopReason: "ci_failed",
        stoppedCause: "ci_failed",
        mergeSource: "agent",
        mergeVerified: true,
      },
      expected: null,
    },
    {
      name: "設計の質問で停止中は GitHub merge を確認しても完了しない",
      context: {
        state: "stopped",
        stoppedFrom: "design",
        stopReason: "question",
        stoppedCause: "needs_human",
        mergeSource: "github",
        mergeVerified: true,
      },
      expected: null,
    },
  ] satisfies { name: string; context: TransitionContext; expected: Transition | null }[])(
    "$name",
    ({ context, expected }) => {
      expect(transition(context, "implementation_done")).toEqual(expected);
    },
  );
});

describe("停止理由に対応しない復帰のきっかけ", () => {
  it.each([
    {
      name: "CI 失敗の停止は merge の許可では戻さない",
      context: {
        state: "stopped",
        stoppedFrom: "implementing",
        stopReason: "ci_failed",
        stoppedCause: "ci_failed",
      },
      trigger: "merge_allowed",
    },
    {
      name: "質問による停止は実装の修正指示のきっかけでは戻さない",
      context: {
        state: "stopped",
        stoppedFrom: "implementing",
        stopReason: "question",
        stoppedCause: "needs_human",
      },
      trigger: "impl_instruction",
    },
    {
      name: "質問による停止は worktree の再作成失敗では上書きしない",
      context: {
        state: "stopped",
        stoppedFrom: "design",
        stopReason: "question",
        stoppedCause: "agent_question",
        worktreeReady: false,
      },
      trigger: "worktree_failed",
    },
    {
      name: "AI の失敗による停止は worktree の再作成失敗では上書きしない",
      context: {
        state: "stopped",
        stoppedFrom: "design",
        stopReason: "failed",
        stoppedCause: "agent_failed",
        worktreeReady: false,
      },
      trigger: "worktree_failed",
    },
  ] satisfies { name: string; context: TransitionContext; trigger: TransitionTrigger }[])(
    "$name",
    ({ context, trigger }) => {
      expect(transition(context, trigger)).toBeNull();
    },
  );
});

describe("worktree の再作成結果と取り下げの依存先", () => {
  it.each([
    {
      name: "作り直せて取り下げの依存先が無ければ設計へ戻る",
      worktreeReady: true,
      hasWithdrawnDependencies: false,
      trigger: "agent_resumed",
      expected: { from: "stopped", to: "design", stopReason: null, cause: "agent_resumed" },
    },
    {
      name: "作り直せても取り下げの依存先が残るあいだは設計へ戻らない",
      worktreeReady: true,
      hasWithdrawnDependencies: true,
      trigger: "agent_resumed",
      expected: null,
    },
    {
      name: "作り直せても取り下げの依存先が残れば元の設計を保持して依存の停止へ移す",
      worktreeReady: true,
      hasWithdrawnDependencies: true,
      trigger: "dependency_withdrawn",
      expected: {
        from: "design",
        to: "stopped",
        stopReason: "dependency_withdrawn",
        cause: "dependency_withdrawn",
      },
    },
    {
      name: "作り直せず取り下げの依存先が無ければ元の設計を保持して失敗を記録する",
      worktreeReady: false,
      hasWithdrawnDependencies: false,
      trigger: "worktree_failed",
      expected: {
        from: "design",
        to: "stopped",
        stopReason: "failed",
        cause: "worktree_failed",
      },
    },
    {
      name: "作り直せず取り下げの依存先があっても元の設計を保持して失敗を記録する",
      worktreeReady: false,
      hasWithdrawnDependencies: true,
      trigger: "worktree_failed",
      expected: {
        from: "design",
        to: "stopped",
        stopReason: "failed",
        cause: "worktree_failed",
      },
    },
  ] satisfies {
    name: string;
    worktreeReady: boolean;
    hasWithdrawnDependencies: boolean;
    trigger: TransitionTrigger;
    expected: Transition | null;
  }[])("$name", ({ worktreeReady, hasWithdrawnDependencies, trigger, expected }) => {
    expect(
      transition(
        {
          state: "stopped",
          stoppedFrom: "design",
          stopReason: "failed",
          stoppedCause: "worktree_failed",
          worktreeReady,
          hasWithdrawnDependencies,
        },
        trigger,
      ),
    ).toEqual(expected);
  });
});

describe("取り下げの依存先の有無による停止", () => {
  it.each(["triage", "design", "design_review", "ready", "implementing"] as const)(
    "%s は取り下げの依存先が無ければ依存先の取り下げのきっかけでは止めない",
    (state) => {
      expect(
        transition({ state, hasWithdrawnDependencies: false }, "dependency_withdrawn"),
      ).toBeNull();
    },
  );

  it.each([
    { stopReason: "question", stoppedFrom: "triage", stoppedCause: "needs_human" },
    { stopReason: "failed", stoppedFrom: "design", stoppedCause: "agent_failed" },
    { stopReason: "usage_limit", stoppedFrom: "design", stoppedCause: "agent_usage_limit" },
    { stopReason: "ci_failed", stoppedFrom: "implementing", stoppedCause: "ci_failed" },
    { stopReason: "merge_confirm", stoppedFrom: "implementing", stoppedCause: "ready_for_merge" },
  ] satisfies {
    stopReason: IssueStopReason;
    stoppedFrom: IssueState;
    stoppedCause: StateChangeCause;
  }[])(
    "$stopReason の停止からは取り下げの依存先が残っているときだけ依存の停止へ移す",
    ({ stopReason, stoppedFrom, stoppedCause }) => {
      const context = { state: "stopped", stopReason, stoppedFrom, stoppedCause } as const;

      expect(
        transition({ ...context, hasWithdrawnDependencies: false }, "dependency_withdrawn"),
      ).toBeNull();
      expect(
        transition({ ...context, hasWithdrawnDependencies: true }, "dependency_withdrawn"),
      ).toEqual({
        from: stoppedFrom,
        to: "stopped",
        stopReason: "dependency_withdrawn",
        cause: "dependency_withdrawn",
      });
    },
  );
});

describe("表に無いきっかけ", () => {
  it.each([
    [{ state: "draft" }, "impl_started"],
    [{ state: "withdrawn" }, "confirm"],
    [{ state: "done" }, "withdraw"],
    [{ state: "design" }, "design_reflected"],
    [{ state: "design" }, "design_pr_not_merged"],
    [{ state: "triage", triageResult: "parent" }, "triage_reported"],
    [
      { state: "ready", dependenciesDone: false, hasCapacity: true, stageEnabled: true },
      "impl_started",
    ],
    [
      { state: "ready", dependenciesDone: true, hasCapacity: false, stageEnabled: true },
      "impl_started",
    ],
    [
      { state: "ready", dependenciesDone: true, hasCapacity: true, stageEnabled: false },
      "impl_started",
    ],
    [
      {
        state: "ready",
        hasChildren: true,
        dependenciesDone: true,
        hasCapacity: true,
        stageEnabled: true,
      },
      "impl_started",
    ],
    [{ state: "implementing", mergeVerified: false }, "implementation_done"],
    [
      { state: "stopped", stoppedFrom: "design", mergeVerified: true, mergeSource: "github" },
      "implementation_done",
    ],
    [{ state: "implementing", confirmBeforeMerge: false }, "ready_for_merge"],
    [{ state: "stopped", stopReason: "ci_failed", stoppedFrom: "implementing" }, "agent_resumed"],
    [{ state: "stopped", stopReason: "question" }, "agent_resumed"],
    [
      {
        state: "stopped",
        stopReason: "failed",
        stoppedFrom: "design",
        stoppedCause: "worktree_failed",
        worktreeReady: false,
      },
      "agent_resumed",
    ],
    [
      {
        state: "stopped",
        stopReason: "question",
        stoppedFrom: "triage",
        hasWithdrawnDependencies: true,
      },
      "agent_resumed",
    ],
    [{ state: "stopped", stopReason: "question", stoppedFrom: "triage" }, "dependency_cleared"],
    [
      {
        state: "stopped",
        stopReason: "dependency_withdrawn",
        stoppedFrom: "ready",
        hasWithdrawnDependencies: true,
      },
      "dependency_cleared",
    ],
    [
      {
        state: "stopped",
        stopReason: "dependency_withdrawn",
        stoppedFrom: "ready",
        hasWithdrawnDependencies: true,
      },
      "dependency_withdrawn",
    ],
    [
      { state: "ready", hasChildren: true, allChildrenClosed: true, hasDoneChild: false },
      "children_closed",
    ],
    [
      { state: "ready", hasChildren: true, allChildrenClosed: false, hasDoneChild: true },
      "children_closed",
    ],
    [{ state: "done", hasChildren: false }, "child_reopened"],
  ] satisfies [TransitionContext, TransitionTrigger][])(
    "%j に %s が来ても移さない",
    (context, trigger) => {
      expect(transition(context, trigger)).toBeNull();
    },
  );

  it.each(["question", "failed", "usage_limit"] as const)(
    "%s の停止からは停止前の段階に戻れる",
    (stopReason) => {
      for (const stoppedFrom of ["triage", "design", "implementing"] as const) {
        expect(transition({ state: "stopped", stopReason, stoppedFrom }, "agent_resumed")).toEqual({
          from: "stopped",
          to: stoppedFrom,
          stopReason: null,
          cause: "agent_resumed",
        });
      }
    },
  );
});
