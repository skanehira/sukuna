import type { Result } from "neverthrow";
import type { TimelineInputComment } from "../../../../shared/progress/schema";

export type QueueItem = {
  id: string;
  text: string;
  images: string[];
  position: number;
  stockItemId: string | null;
  clientId: string | null;
  createdAt: number;
  timeline_comments?: TimelineInputComment[];
};
export type MessageDependencies = {
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
