import type {
  ClockPort,
  IssueNotice,
  IssueNoticePort,
  IssueRepositoryPort,
  IssueUnitOfWorkPort,
} from "../domain/ports";
import { transition, type TransitionContext, type TransitionTrigger } from "../domain/transition";

export type TransitionFacts = Pick<
  TransitionContext,
  | "triageResult"
  | "hasCapacity"
  | "stageEnabled"
  | "mergeVerified"
  | "mergeSource"
  | "worktreeReady"
>;

export type MoveStateCommand = {
  issueId: string;
  trigger: TransitionTrigger;
  detail?: string;
  facts?: TransitionFacts;
};

export type MoveStateResult =
  | { kind: "moved"; notice: IssueNotice }
  | { kind: "unchanged" }
  | { kind: "not_found" };

export type MoveStateDeps = {
  unitOfWork: IssueUnitOfWorkPort;
  notices: IssueNoticePort;
  clock: ClockPort;
};

export function createMoveState(deps: MoveStateDeps) {
  return (command: MoveStateCommand): MoveStateResult => {
    const result = deps.unitOfWork.run((repository) =>
      moveStateWithin(repository, command, deps.clock.now()),
    );
    if (result.kind === "moved") deps.notices.publish(result.notice);
    return result;
  };
}

export function moveStateWithin(
  repository: IssueRepositoryPort,
  command: MoveStateCommand,
  now: number,
): MoveStateResult {
  const issue = repository.getIssue(command.issueId);
  if (issue === undefined) return { kind: "not_found" };
  const context = { ...repository.contextOf(issue), ...command.facts };
  let next = transition(context, command.trigger);
  if (
    next === null &&
    context.hasWithdrawnDependencies &&
    ["agent_resumed", "merge_allowed", "impl_instruction"].includes(command.trigger)
  ) {
    const withoutDependency = transition(
      { ...context, hasWithdrawnDependencies: false },
      command.trigger,
    );
    if (withoutDependency !== null) next = transition(context, "dependency_withdrawn");
  }
  if (next === null || next.cause === null) return { kind: "unchanged" };
  const detail =
    next.to !== "stopped"
      ? null
      : next.stopReason === "dependency_withdrawn"
        ? repository
            .withdrawnDependencies(issue.id)
            .map((dependency) => `#${dependency.number}`)
            .join(" ")
        : (command.detail ?? null);
  const notice = repository.saveStateChange(issue, { ...next, cause: next.cause, detail }, now);
  return { kind: "moved", notice };
}
