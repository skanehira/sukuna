import { err, ok, type Result } from "neverthrow";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";

export async function workspaceContext(
  id: string,
  deps: WorkspaceDependencies,
): Promise<Result<{ cwd: string }, WorkspaceError>> {
  const conversation = deps.repository.conversation(id);
  if (conversation.isErr()) return err(conversation.error);
  if (!conversation.value) return err({ code: "not_found", message: "会話がありません" });
  const { cwd } = conversation.value;
  const info = await deps.fs.stat(cwd);
  if ((info.isErr() && info.error.code === "not_found") || (info.isOk() && !info.value.directory))
    return err({ code: "conflict", message: `この会話の作業ディレクトリがありません (${cwd})` });
  if (info.isErr()) return err(info.error);
  return ok({ cwd });
}
