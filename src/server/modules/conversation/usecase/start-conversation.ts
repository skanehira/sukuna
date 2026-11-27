import { err, ok } from "neverthrow";
import { z } from "zod";
import type { ConversationDependencies, ConversationError } from "../domain/ports";
export async function startConversation(projectId: string, deps: ConversationDependencies) {
  const project = deps.repository.project(projectId);
  if (!project)
    return err<never, ConversationError>({
      code: "not_found",
      message: "プロジェクトが見つかりません。",
    });
  const result = await deps.runner.call("POST", "/conversations", {
    project_id: projectId,
    kind: "chat",
    cwd: project.path,
    title: "新しい会話",
  });
  if (result.isErr()) return err(result.error);
  if (result.value.status >= 400) return ok(result.value);
  const body = z.object({ conversation_id: z.string() }).parse(result.value.body);
  return ok({
    status: 201,
    body: { conversation: deps.repository.conversation(body.conversation_id) },
  });
}
