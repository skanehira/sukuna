import type { ConversationDependencies } from "../domain/ports";
export function reopen(
  id: string,
  deps: Pick<ConversationDependencies, "repository" | "reopened">,
): void {
  const ids = deps.repository.transaction(() => deps.repository.reopen(id));
  if (ids.length) deps.reopened(ids);
}
