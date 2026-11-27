import type { FinishWithdrawal, IssueNotice, StopConversationPort } from "../domain/ports";
import { createMoveState, moveStateWithin, type MoveStateDeps } from "./move-state";

class WithdrawalExpired extends Error {}

export function createDependencyWithdrawn(
  deps: MoveStateDeps & { conversations: StopConversationPort },
) {
  const move = createMoveState(deps);
  return {
    withdraw: async (
      issueId: string,
      ownConversations: string[] = [],
      callerCancelled = () => false,
      finish?: FinishWithdrawal,
    ) => {
      if (callerCancelled()) return { kind: "caller_cancelled" as const };
      const commit = () =>
        deps.unitOfWork.run((repository) => {
          if (callerCancelled()) throw new WithdrawalExpired();
          const now = deps.clock.now();
          const result = moveStateWithin(repository, { issueId, trigger: "withdraw" }, now);
          const notices: IssueNotice[] = [];
          const conversations = new Map<string, "dependency_withdrawn" | undefined>();
          if (result.kind !== "moved") return { result, notices, conversations };
          for (const id of ownConversations) conversations.set(id, undefined);
          notices.push(result.notice);
          for (const dependentId of repository.dependentIssueIds(issueId)) {
            const dependent = repository.getIssue(dependentId);
            if (dependent === undefined || ["draft", "done", "withdrawn"].includes(dependent.state))
              continue;
            if (dependent.state !== "stopped") {
              const stopped = moveStateWithin(
                repository,
                { issueId: dependentId, trigger: "dependency_withdrawn" },
                now,
              );
              if (stopped.kind === "moved") notices.push(stopped.notice);
            }
            for (const id of repository.workingStageConversationIds(dependentId))
              conversations.set(id, "dependency_withdrawn");
          }
          if (callerCancelled()) throw new WithdrawalExpired();
          return { result, notices, conversations };
        });
      let committed: ReturnType<typeof commit>;
      try {
        committed = commit();
      } catch (error) {
        if (error instanceof WithdrawalExpired) return { kind: "caller_cancelled" as const };
        throw error;
      }
      if (committed.result.kind !== "moved") return committed.result;
      const stops = [...committed.conversations].map(
        ([id, cause]) =>
          (finish ? deps.conversations.prepareStop?.(id, cause) : undefined) ??
          (() => deps.conversations.stop(id, cause)),
      );
      for (const notice of committed.notices) deps.notices.publish(notice);
      const stop = async () => {
        const results = await Promise.allSettled(stops.map(async (request) => request()));
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason));
      };
      if (finish) {
        finish(issueId, stop);
        return committed.result;
      }
      try {
        await stop();
        return committed.result;
      } catch {
        return { kind: "stop_failed" as const };
      }
    },
    clear: (issueId: string) => move({ issueId, trigger: "dependency_cleared" }),
  };
}
