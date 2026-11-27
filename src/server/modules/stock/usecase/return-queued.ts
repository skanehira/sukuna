import type { ConversationRepository } from "../../conversation/domain/ports";
export function returnQueuedStock(
  id: string,
  repository: Pick<ConversationRepository, "returnStock">,
): void {
  repository.returnStock(id);
}
