import { MergeStateConflict } from "../domain/merge-ports";
import { WorktreeActivityBusy } from "../../../../shared/workspace/worktree-activity";
import { and, desc, eq, isNull, max } from "drizzle-orm";
import { err } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations, issues, projects, issueEvents } from "../../../../shared/db/schema";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import { activeStates } from "../../conversation/usecase/runtime";
import type { IssueNoticePort } from "../domain/ports";
import { createAllowMerge } from "../usecase/allow-merge";
import { createIssueRepository } from "./issue-repository";
import { createIssueDataRepository } from "../../../../server/modules/issue/adapter/issue-repository";
export function createRunnerAllowMerge(
  db: OpenedDatabase["db"],
  runtime: ConversationRuntime,
  notices: IssueNoticePort,
) {
  const repository = {
    get(id: string) {
      const issue = db.select().from(issues).where(eq(issues.id, id)).get();
      if (!issue) return;
      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, issue.projectId), isNull(projects.removedAt)))
        .get();
      if (!project) return;
      const conversation = db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.issueId, id),
            eq(conversations.kind, "impl"),
            isNull(conversations.closedAt),
          ),
        )
        .orderBy(desc(conversations.id))
        .get();
      return {
        id,
        projectId: issue.projectId,
        state: issue.state,
        stopReason: issue.stopReason,
        conversationId: conversation?.id ?? null,
        usesGithub: project.usesGithub,
      };
    },
    accept(id: string, headSha: string, now: number) {
      runtime.store.withWorktreeReservation((reservation) => {
        const flow = createIssueRepository(db, reservation);
        const issue = flow.getIssue(id);
        if (!issue || issue.state !== "stopped" || issue.stopReason !== "merge_confirm")
          throw new MergeStateConflict();
        const data = createIssueDataRepository(db);
        data.append(id, "merge_allowed", { headSha }, now);
        const saved = flow.saveStateChange(
          issue,
          {
            from: "stopped",
            to: "implementing",
            stopReason: null,
            detail: null,
            cause: "merge_allowed",
          },
          now,
        );
        if (!saved) throw new WorktreeActivityBusy();
        const last = db
          .select()
          .from(issueEvents)
          .where(and(eq(issueEvents.issueId, id), eq(issueEvents.type, "stage_changed")))
          .orderBy(desc(issueEvents.seq))
          .get();
        if (JSON.stringify(last?.payload) !== JSON.stringify({ stage: "ci" }))
          data.append(id, "stage_changed", { stage: "ci" }, now);
      });
    },
  };
  return createAllowMerge({
    repository,
    now: () => runtime.options.clock.now(),
    changed: (issue) => {
      const seq =
        db
          .select({ seq: max(issueEvents.seq) })
          .from(issueEvents)
          .where(eq(issueEvents.issueId, issue.id))
          .get()?.seq ?? 0;
      notices.publish({ kind: "issue", issue_id: issue.id, project_id: issue.projectId, seq });
    },
    deliver: (id, text, accept) =>
      runtime.serial(id, async () => {
        const current = repository.get(runtime.store.get(id)?.issueId ?? "");
        if (
          runtime.closing ||
          !current ||
          current.state !== "stopped" ||
          current.stopReason !== "merge_confirm" ||
          activeStates.includes(runtime.store.get(id)?.runState ?? "idle") ||
          runtime.releases.has(id)
        )
          return err({ code: "conflict", message: new MergeStateConflict().message });
        try {
          return (
            await runtime.deliver(
              id,
              { text, images: [], origin: "flow" },
              { events: [], before: accept },
              { includeQueued: false },
            )
          ).map(() => undefined);
        } catch (error) {
          if (error instanceof MergeStateConflict)
            return err({ code: "conflict", message: error.message });
          throw error;
        }
      }),
  });
}
