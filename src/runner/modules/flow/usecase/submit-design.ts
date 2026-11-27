import { err, ok } from "neverthrow";
import { designConflict, designEvents, designNotFound } from "../../../../shared/api/design";
import { issueToolSchemas } from "../../../../shared/issue/schema";
import type { DesignFlowDependencies } from "../domain/design-ports";
import { designInternal } from "../domain/design-ports";

export function createSubmitDesign(deps: DesignFlowDependencies) {
  return async (
    id: string,
    conversationId: string,
    input: { policy: string; checks: string[] },
  ) => {
    const record = deps.repo.read(id);
    if (!record) return err(designNotFound);
    const parsed = issueToolSchemas.report_design.safeParse({
      ...input,
      number: record.issue.number,
    });
    if (!parsed.success)
      return err({
        code: "invalid_input" as const,
        message: "修正方針と確かめたい点を確認してください",
      });
    const tree = deps.repo.findTree(id, record.project.id, record.issue.number);
    if (
      record.issue.state !== "design" ||
      record.conversation?.id !== conversationId ||
      record.conversation.worktreeId !== tree?.id ||
      !tree ||
      designEvents(record.events).pr
    )
      return err(designConflict);
    const range = await deps.git.range(record.project, tree.branch);
    if (range.isErr())
      return err(designInternal(`設計のコミットを記録できませんでした: ${range.error.message}`));
    const lease = deps.activity.acquire([tree.id]);
    if (lease.isErr()) return err(lease.error);
    try {
      const notice = deps.transaction((repo) => {
        const current = repo.read(id);
        if (
          !current ||
          current.issue.state !== "design" ||
          current.conversation?.id !== conversationId ||
          current.conversation.worktreeId !== tree.id ||
          designEvents(current.events).pr
        )
          return null;
        const now = deps.clock.now();
        if (!repo.move(current, "design_submitted", now)) return null;
        return repo.append(
          current,
          "design_submitted",
          {
            policy: parsed.data.policy,
            checks: parsed.data.checks,
            branch: tree.branch,
            ...range.value,
          },
          now,
        );
      }, lease.value);
      if (!notice) return err(designConflict);
      deps.notices.publish(notice);
      return ok(undefined);
    } finally {
      lease.value.release();
    }
  };
}
