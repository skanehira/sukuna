import { err, ok, type Result } from "neverthrow";
import type { PrResponse } from "../../../../shared/api/pr";
import type { PrDependencies, PrError } from "../domain/pr-ports";
export async function getPr(
  id: string,
  deps: PrDependencies,
): Promise<Result<PrResponse, PrError>> {
  const ctx = deps.repository.context(id);
  if (!ctx)
    return err({ code: "not_found", message: "issue が見つかりません。開き直してください。" });
  const base: PrResponse = {
    issueId: id,
    source: "none",
    pr: null,
    checks: [],
    evidence: { markdown: "", images: [] },
    files: [],
    local: null,
    diffTooLarge: false,
    earlierPrUrls: ctx.earlierPrUrls,
    fetchedAt: deps.now(),
    fetchError: null,
    waitingMergeConfirm: ctx.issue.state === "stopped" && ctx.issue.stopReason === "merge_confirm",
    implConversationId: ctx.implConversationId,
    worktree: ctx.worktree ? { id: ctx.worktree.id, path: ctx.worktree.path } : null,
    unsentInstructionCount: ctx.unsentInstructionCount,
  };
  if (!ctx.project.usesGithub) {
    if (!ctx.worktree) return ok(base);
    const local = await deps.git.read(
      ctx.project.path,
      ctx.worktree.branch,
      ctx.project.defaultBranch,
    );
    if (local.isErr()) return err(local.error);
    const { files, ...branch } = local.value;
    return ok({ ...base, source: "local", local: branch, files });
  }
  const url = ctx.issue.prUrl;
  if (!url) return ok(base);
  const fetched = await deps.github.read(url, ctx.project.path);
  if (fetched.isErr()) {
    const cached = deps.repository.snapshot(id, url);
    return cached ? ok({ ...cached, fetchError: fetched.error.message }) : err(fetched.error);
  }
  const payload: PrResponse = { ...base, source: "github", ...fetched.value };
  deps.repository.saveSnapshot(id, url, payload);
  if (
    payload.pr?.state === "merged" &&
    (ctx.issue.state === "implementing" ||
      (ctx.issue.state === "stopped" && ctx.stoppedFromImplementation))
  )
    await deps.runner.forward("POST", "/flow/notify", { issue_id: id });
  return ok(payload);
}
