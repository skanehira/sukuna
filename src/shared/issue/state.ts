import { z } from "zod";

export const issueStateSchema = z.enum([
  "draft",
  "triage",
  "design",
  "design_review",
  "ready",
  "implementing",
  "stopped",
  "done",
  "withdrawn",
]);
export const issueStopReasonSchema = z.enum([
  "question",
  "failed",
  "usage_limit",
  "ci_failed",
  "merge_confirm",
  "dependency_withdrawn",
]);
export const stateChangeCauseSchema = z.enum([
  "ai_created",
  "confirm",
  "triage_reported",
  "needs_human",
  "agent_question",
  "agent_failed",
  "no_report",
  "worktree_failed",
  "agent_usage_limit",
  "design_submitted",
  "design_reflected",
  "design_pr_not_merged",
  "design_pr_created",
  "design_rejected",
  "impl_started",
  "ci_failed",
  "ready_for_merge",
  "implementation_done",
  "merge_allowed",
  "impl_instruction",
  "agent_resumed",
  "dependency_withdrawn",
  "dependency_cleared",
  "reopened_for_fix",
  "withdraw",
  "restart_question",
  "reopen",
  "children_closed",
  "child_reopened",
]);

export type IssueState = z.infer<typeof issueStateSchema>;
export type IssueStopReason = z.infer<typeof issueStopReasonSchema>;
export type StateChangeCause = z.infer<typeof stateChangeCauseSchema>;

export const stateChangedSchema = z
  .object({
    from: issueStateSchema.nullable(),
    to: issueStateSchema,
    stopReason: issueStopReasonSchema.nullable(),
    detail: z
      .string()
      .regex(/^[^\r\n]+$/)
      .nullable(),
    cause: stateChangeCauseSchema,
  })
  .refine((value) =>
    value.to === "stopped"
      ? value.stopReason !== null && value.detail !== null
      : value.stopReason === null && value.detail === null,
  );

export type StateChanged = z.infer<typeof stateChangedSchema>;
export type TransitionTrigger = StateChangeCause | "create_draft" | "design_reflect_failed";
export type TransitionCondition =
  | "always"
  | "triage_design"
  | "triage_designed"
  | "children"
  | "no_children"
  | "design_pr_pending"
  | "implementation_available"
  | "merge_confirmation"
  | "agent_merge"
  | "github_merge"
  | "merge_stopped"
  | "ci_stopped"
  | "resumable"
  | "worktree_retried"
  | "worktree_retry_failed"
  | "resume_dependency"
  | "dependency_gone"
  | "dependency_present"
  | "children_complete";

export type TransitionRule = {
  from: readonly (IssueState | null)[];
  to: IssueState | "previous";
  trigger: TransitionTrigger;
  stopReason: IssueStopReason | null;
  cause: StateChangeCause | null;
  condition: TransitionCondition;
};

function rule(
  from: (IssueState | null)[],
  to: TransitionRule["to"],
  trigger: TransitionTrigger,
  stopReason: IssueStopReason | null = null,
  condition: TransitionCondition = "always",
): TransitionRule {
  return {
    from,
    to,
    trigger,
    stopReason,
    condition,
    cause: trigger === "create_draft" || trigger === "design_reflect_failed" ? null : trigger,
  };
}

export const ISSUE_TRANSITIONS: readonly TransitionRule[] = [
  rule([null], "draft", "create_draft"),
  rule([null], "triage", "ai_created"),
  rule(["draft"], "triage", "confirm"),
  rule(["triage"], "design", "triage_reported", null, "triage_design"),
  rule(["triage"], "ready", "triage_reported", null, "triage_designed"),
  rule(["triage"], "ready", "triage_reported", null, "children"),
  rule(["triage", "design"], "stopped", "needs_human", "question"),
  rule(["triage", "design"], "stopped", "agent_question", "question"),
  rule(["triage", "design"], "stopped", "agent_failed", "failed"),
  rule(["triage", "design"], "stopped", "no_report", "failed"),
  rule(["design"], "stopped", "worktree_failed", "failed"),
  rule(["triage", "design"], "stopped", "agent_usage_limit", "usage_limit"),
  rule(["design"], "design_review", "design_submitted"),
  rule(["design"], "ready", "design_reflected", null, "design_pr_pending"),
  rule(["design"], "stopped", "design_pr_not_merged", "failed", "design_pr_pending"),
  rule(["design_review"], "ready", "design_reflected", null, "no_children"),
  rule(["design_review"], "ready", "design_reflected", null, "children"),
  rule(["design_review"], "design", "design_pr_created"),
  rule(["design_review"], "design", "design_rejected"),
  rule(["design_review"], "design_review", "design_reflect_failed"),
  rule(["ready"], "implementing", "impl_started", null, "implementation_available"),
  rule(["implementing"], "stopped", "needs_human", "question"),
  rule(["implementing"], "stopped", "agent_question", "question"),
  rule(["implementing"], "stopped", "agent_failed", "failed"),
  rule(["implementing"], "stopped", "no_report", "failed"),
  rule(["implementing"], "stopped", "worktree_failed", "failed"),
  rule(["implementing"], "stopped", "agent_usage_limit", "usage_limit"),
  rule(["implementing"], "stopped", "ci_failed", "ci_failed"),
  rule(["implementing"], "stopped", "ready_for_merge", "merge_confirm", "merge_confirmation"),
  rule(["implementing"], "done", "implementation_done", null, "agent_merge"),
  rule(["implementing", "stopped"], "done", "implementation_done", null, "github_merge"),
  rule(["stopped"], "implementing", "merge_allowed", null, "merge_stopped"),
  rule(["stopped"], "implementing", "impl_instruction", null, "merge_stopped"),
  rule(["stopped"], "implementing", "impl_instruction", null, "ci_stopped"),
  rule(["stopped"], "previous", "agent_resumed", null, "resumable"),
  rule(["stopped"], "previous", "agent_resumed", null, "worktree_retried"),
  rule(["stopped"], "stopped", "worktree_failed", "failed", "worktree_retry_failed"),
  rule(["stopped"], "stopped", "dependency_withdrawn", "dependency_withdrawn", "resume_dependency"),
  rule(["stopped"], "previous", "dependency_cleared", null, "dependency_gone"),
  rule(["done"], "implementing", "reopened_for_fix"),
  rule(
    ["draft", "triage", "design", "design_review", "ready", "implementing", "stopped"],
    "withdrawn",
    "withdraw",
  ),
  rule(
    ["triage", "design", "design_review", "ready", "implementing"],
    "stopped",
    "dependency_withdrawn",
    "dependency_withdrawn",
    "dependency_present",
  ),
  rule(
    ["triage", "design", "ready"],
    "stopped",
    "dependency_withdrawn",
    "dependency_withdrawn",
    "dependency_present",
  ),
  rule(["triage", "design", "implementing"], "stopped", "restart_question", "question"),
  rule(["done", "withdrawn"], "triage", "reopen"),
  rule(["ready"], "done", "children_closed", null, "children_complete"),
  rule(["done"], "ready", "child_reopened", null, "children"),
];
