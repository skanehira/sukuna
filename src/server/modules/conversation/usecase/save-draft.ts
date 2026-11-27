import { err, ok } from "neverthrow";
import {
  draftReceipt,
  sameDraftReceipt,
  type ConversationDraftRequest,
} from "../../../../shared/conversation/api";
import {
  emptyDraft,
  missingConversation,
  type ConversationDependencies,
  type ConversationError,
} from "../domain/ports";

const draftChanged: ConversationError = {
  code: "conflict",
  message: "別の端末の保存を残しました。このタブの編集は入力欄に残っています。",
};

export function saveDraft(
  id: string,
  input: ConversationDraftRequest,
  deps: ConversationDependencies,
) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const result = deps.repository.transaction(() => {
    const previous = deps.repository.draft(id);
    const draft = draftReceipt(input);
    const older = previous !== null && input.editedAt <= previous.updatedAt;
    if (input.expectedDraft !== undefined) {
      if (sameDraftReceipt(draft, previous))
        return ok({ applied: false, draft: emptyDraft(previous) });
      if (older || !sameDraftReceipt(input.expectedDraft, previous)) return err(draftChanged);
    } else if (older) {
      return ok({ applied: false, draft: emptyDraft(previous) });
    }
    deps.repository.writeDraft(id, draft);
    return ok({ applied: true, draft: emptyDraft(draft) });
  });
  if (result.isOk() && result.value.applied) deps.changed(id, ["draft"]);
  return result;
}
