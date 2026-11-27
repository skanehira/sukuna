import { err, ok } from "neverthrow";
import type { z } from "zod";
import type { saveConversationDraftSchema } from "../../../../shared/conversation/api";
import { emptyDraft, missingConversation, type ConversationDependencies } from "../domain/ports";
export function saveDraft(
  id: string,
  input: z.infer<typeof saveConversationDraftSchema>,
  deps: ConversationDependencies,
) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const result = deps.repository.transaction(() => {
    const previous = deps.repository.draft(id);
    if (previous && input.editedAt <= previous.updatedAt)
      return { applied: false, draft: emptyDraft(previous) };
    const draft = {
      text: input.text,
      images: input.images,
      updatedAt: input.editedAt,
      updatedBy: input.clientId,
    };
    deps.repository.writeDraft(id, draft);
    return { applied: true, draft: emptyDraft(draft) };
  });
  if (result.applied) deps.changed(id, ["draft"]);
  return ok(result);
}
