import type { ConversationMessage } from "../../../../shared/conversation/api";
import type { Result } from "neverthrow";

export type QueueItem = import("../../../../shared/conversation/api").ConversationQueueItem;
export type MessageDependencies = {
  receiptMetadata?: boolean;
  prepareAcceptance?: (
    id: string,
    input: Pick<ConversationMessage, "text" | "images" | "preserveDraft">,
  ) => (duplicate: boolean) => void;
  runner: {
    call(
      method: string,
      path: string,
      input?: unknown,
    ): Promise<Result<{ status: number; body: unknown }, { code: string; message: string }>>;
  };
  repository: {
    queueItem(conversationId: string, itemId: string): QueueItem | null;
  };
};
