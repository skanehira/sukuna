import { err, ok, type Result } from "neverthrow";
import type { PrDependencies, PrError } from "../domain/pr-ports";
import { prConflict } from "../domain/pr-ports";
import { allowMergeSchema } from "../../../../shared/api/pr";
export async function allowMerge(
  id: string,
  input: unknown,
  deps: PrDependencies,
): Promise<Result<Response, PrError>> {
  const parsed = allowMergeSchema.safeParse(input);
  if (!parsed.success)
    return err({
      code: "invalid_input",
      message: "表示した変更を読み直してから許可してください。",
    });
  const ctx = deps.repository.context(id);
  if (!ctx)
    return err({ code: "not_found", message: "issue が見つかりません。開き直してください。" });
  if (ctx.issue.state !== "stopped" || ctx.issue.stopReason !== "merge_confirm")
    return err(prConflict);
  let head: string;
  if (ctx.project.usesGithub) {
    if (!ctx.issue.prUrl) return err(prConflict);
    const current = await deps.github.head(ctx.issue.prUrl, ctx.project.path);
    if (current.isErr()) return err(current.error);
    if (current.value.state !== "open") return err(prConflict);
    head = current.value.headSha;
  } else {
    if (!ctx.worktree) return err(prConflict);
    const current = await deps.git.read(
      ctx.project.path,
      ctx.worktree.branch,
      ctx.project.defaultBranch,
    );
    if (current.isErr()) return err(current.error);
    head = current.value.headSha;
  }
  if (head !== parsed.data.headSha)
    return err({
      code: "conflict",
      message: "表示した後に変更が更新されました。読み直してから許可してください",
    });
  return ok(
    await deps.runner.forward("POST", `/flow/issues/${encodeURIComponent(id)}/pr/allow-merge`, {
      head_sha: head,
    }),
  );
}
