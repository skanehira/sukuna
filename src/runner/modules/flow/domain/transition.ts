import {
  ISSUE_TRANSITIONS,
  type IssueState,
  type IssueStopReason,
  type StateChangeCause,
  type TransitionCondition,
  type TransitionTrigger,
} from "../../../../shared/issue/state";

export type { TransitionTrigger };

export type TransitionContext = {
  state: IssueState | null;
  stopReason?: IssueStopReason | null;
  stoppedFrom?: IssueState | null;
  stoppedCause?: StateChangeCause | null;
  hasChildren?: boolean;
  designed?: boolean;
  triageResult?: "design" | "parent";
  designPrMergePending?: boolean;
  dependenciesDone?: boolean;
  hasCapacity?: boolean;
  stageEnabled?: boolean;
  confirmBeforeMerge?: boolean;
  mergeVerified?: boolean;
  mergeSource?: "agent" | "github";
  worktreeReady?: boolean;
  hasWithdrawnDependencies?: boolean;
  allChildrenClosed?: boolean;
  hasDoneChild?: boolean;
};

export type Transition = {
  from: IssueState | null;
  to: IssueState;
  stopReason: IssueStopReason | null;
  cause: StateChangeCause | null;
};

export function transition(
  context: TransitionContext,
  trigger: TransitionTrigger,
): Transition | null {
  const matched = ISSUE_TRANSITIONS.find(
    (rule) =>
      rule.from.includes(context.state) &&
      rule.trigger === trigger &&
      allows(rule.condition, context),
  );
  if (matched === undefined) return null;
  const to = matched.to === "previous" ? context.stoppedFrom : matched.to;
  if (to === null || to === undefined || (to === "stopped" && matched.to === "previous"))
    return null;
  const from =
    context.state === "stopped" && to === "stopped" ? context.stoppedFrom : context.state;
  if (from === undefined) return null;
  return { from, to, stopReason: matched.stopReason, cause: matched.cause };
}

function allows(condition: TransitionCondition, c: TransitionContext): boolean {
  switch (condition) {
    case "always":
      return true;
    case "triage_design":
      return !c.hasChildren && !c.designed && c.triageResult === "design";
    case "triage_designed":
      return !c.hasChildren && c.designed === true && c.triageResult === "design";
    case "children":
      return c.hasChildren === true;
    case "no_children":
      return !c.hasChildren;
    case "design_pr_pending":
      return c.designPrMergePending === true;
    case "implementation_available":
      return (
        !c.hasChildren &&
        c.dependenciesDone === true &&
        c.hasCapacity === true &&
        c.stageEnabled === true
      );
    case "merge_confirmation":
      return c.confirmBeforeMerge === true;
    case "agent_merge":
      return c.mergeVerified === true && c.mergeSource !== "github";
    case "github_merge":
      return (
        c.mergeVerified === true &&
        c.mergeSource === "github" &&
        (c.state === "implementing" || c.stoppedFrom === "implementing")
      );
    case "merge_stopped":
      return c.stopReason === "merge_confirm" && !c.hasWithdrawnDependencies;
    case "ci_stopped":
      return c.stopReason === "ci_failed" && !c.hasWithdrawnDependencies;
    case "resumable":
      return (
        (c.stopReason === "question" ||
          c.stopReason === "failed" ||
          c.stopReason === "usage_limit") &&
        c.stoppedCause !== "worktree_failed" &&
        !c.hasWithdrawnDependencies
      );
    case "worktree_retried":
      return (
        c.stopReason === "failed" &&
        c.stoppedCause === "worktree_failed" &&
        c.worktreeReady === true &&
        !c.hasWithdrawnDependencies
      );
    case "worktree_retry_failed":
      return c.stopReason === "failed" && c.stoppedCause === "worktree_failed" && !c.worktreeReady;
    case "resume_dependency":
      return (
        c.stopReason !== undefined &&
        c.stopReason !== null &&
        c.stopReason !== "dependency_withdrawn" &&
        c.hasWithdrawnDependencies === true
      );
    case "dependency_gone":
      return c.stopReason === "dependency_withdrawn" && !c.hasWithdrawnDependencies;
    case "dependency_present":
      return c.hasWithdrawnDependencies === true;
    case "children_complete":
      return c.hasChildren === true && c.allChildrenClosed === true && c.hasDoneChild === true;
  }
}
