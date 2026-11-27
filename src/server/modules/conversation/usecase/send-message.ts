import type { ConversationContent } from "../../../../shared/conversation/api";
import type { ConversationDependencies } from "../domain/ports";
import { reopen } from "./reopen";
export function prepareMessageAcceptance(
  id: string,
  input: ConversationContent,
  deps: ConversationDependencies,
): (duplicate: boolean) => void {
  const previous = deps.repository.draft(id);
  return (duplicate) => {
    if (duplicate) return;
    const cleared = deps.repository.transaction(() => {
      const current = deps.repository.draft(id);
      if (
        (!input.text && !input.images.length) ||
        !previous ||
        !current ||
        previous.updatedAt !== current.updatedAt ||
        previous.updatedBy !== current.updatedBy ||
        previous.text !== current.text ||
        JSON.stringify(previous.images) !== JSON.stringify(current.images)
      )
        return false;
      deps.repository.writeDraft(id, {
        text: "",
        images: [],
        updatedAt: Math.max(deps.now(), current.updatedAt),
        updatedBy: current.updatedBy,
      });
      return true;
    });
    if (cleared) deps.changed(id, ["draft"]);
    reopen(id, deps);
  };
}
