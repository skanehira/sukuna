import type { IssueNotice, StopConversationPort } from "../domain/ports";
import { createMoveState, moveStateWithin, type MoveStateDeps } from "./move-state";

export function createDependencyWithdrawn(
  deps: MoveStateDeps & { conversations: StopConversationPort },
) {
  const move = createMoveState(deps);
  return {
    withdraw: async (issueId: string, ownConversations: string[] = []) => {
      const committed = deps.unitOfWork.run((repository) => {
        const now = deps.clock.now();
        const result = moveStateWithin(repository, { issueId, trigger: "withdraw" }, now);
        const notices: IssueNotice[] = [];
        const conversations = new Set<string>();
        if (result.kind !== "moved") return { result, notices, conversations };
        for (const id of ownConversations) conversations.add(id);
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
            conversations.add(id);
        }
        return { result, notices, conversations };
      });
      for (const notice of committed.notices) deps.notices.publish(notice);
      const stopped = await Promise.allSettled(
        [...committed.conversations].map((id) => deps.conversations.stop(id)),
      );
      if (stopped.some((result) => result.status === "rejected"))
        return { kind: "stop_failed" as const };
      return committed.result;
    },
    clear: (issueId: string) => move({ issueId, trigger: "dependency_cleared" }),
  };
}
