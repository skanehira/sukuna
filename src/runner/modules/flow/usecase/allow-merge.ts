import { err, ok, type Result } from "neverthrow";
import type { AllowMergeDependencies } from "../domain/merge-ports";
import type { OperationError } from "../../conversation/usecase/runtime";
export function createAllowMerge(deps: AllowMergeDependencies) {
  return async (
    id: string,
    headSha: string,
  ): Promise<Result<{ state: "implementing" }, OperationError>> => {
    const issue = deps.repository.get(id);
    if (!issue)
      return err({ code: "not_found", message: "issue が見つかりません。開き直してください。" });
    if (issue.state !== "stopped" || issue.stopReason !== "merge_confirm" || !issue.conversationId)
      return err({
        code: "conflict",
        message: "issue の状態が変わりました。読み直してから操作してください。",
      });
    const text = issue.usesGithub
      ? "merge を許可されました。merge の手順で CI を待って merge してください"
      : "merge を許可されました。merge の手順で既定ブランチへ入れてください";
    const delivered = await deps.deliver(issue.conversationId, text, () =>
      deps.repository.accept(id, headSha, deps.now()),
    );
    if (delivered.isErr()) return err(delivered.error);
    deps.changed(issue);
    return ok({ state: "implementing" });
  };
}
