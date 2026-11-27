import { err, ok, type Result } from "neverthrow";
import type { ClosingSummary } from "../../../../shared/lifecycle";
import {
  closingConflict,
  isWorking,
  lifecycleMissing,
  type LifecycleDependencies,
  type LifecycleError,
} from "../domain/lifecycle";

export async function getClosingSummary(
  id: string,
  deps: LifecycleDependencies,
): Promise<Result<ClosingSummary, LifecycleError>> {
  const source = deps.repository.summary(id);
  if (!source) return err(lifecycleMissing);
  if (source.conversation.kind !== "chat") return err(closingConflict);
  const runningThreads = deps.repository
    .threads(id)
    .filter(({ runState }) => isWorking(runState))
    .map(({ id, title, runState }) => ({ id, title, runState }));
  const [git, files] = await Promise.all([
    deps.git(source.conversation.cwd, source.project, source.firstEventAt),
    deps.changedFiles(id),
  ]);
  return ok({
    working: isWorking(source.conversation.runState),
    outputs: {
      issues: { ok: true, items: source.createdIssues },
      files: files.isOk()
        ? { ok: true, items: files.value }
        : { ok: false, error: files.error.message },
      ...git.outputs,
    },
    remaining: { stock: source.stock, runningThreads, ...git.remaining },
    git: git.git,
  });
}
