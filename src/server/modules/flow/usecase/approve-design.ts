import { err, ok, type Result } from "neverthrow";
import {
  approveDesignInputSchema,
  designEvents,
  designSubmittedSchema,
  designNotFound,
  designConflict,
  designReflecting,
  designStale,
  type DesignError,
} from "../../../../shared/api/design";
import type { DesignDependencies } from "../domain/design-ports";

export async function approveDesign(
  id: string,
  input: unknown,
  deps: DesignDependencies,
): Promise<Result<Response, DesignError>> {
  const parsed = approveDesignInputSchema.safeParse(input);
  if (!parsed.success)
    return err({ code: "invalid_input", message: "表示中の設計のコミットを確認してください。" });
  const record = deps.read(id);
  if (!record) return err(designNotFound);
  if (record.issue.state !== "design_review") return err(designConflict);
  const history = designEvents(record.events);
  if (history.reflecting) return err(designReflecting);
  const submission = designSubmittedSchema.safeParse(history.submission?.payload);
  const { headCommit } = parsed.data;
  if (
    !submission.success ||
    submission.data.headCommit !== headCommit ||
    (await deps.git.head(record.project.path, submission.data.branch)) !== headCommit
  )
    return err(designStale);
  return ok(
    await deps.runner.forward("POST", `/flow/issues/${encodeURIComponent(id)}/design/approve`, {
      head_commit: headCommit,
    }),
  );
}
