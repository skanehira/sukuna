import type { ConversationStore } from "../domain/conversation-store";
import type { RateLimit } from "../domain/stop-reason";
export function recordRateLimit(store: ConversationStore, rate: RateLimit, now: number): void {
  store.saveRateLimit({
    status: rate.status,
    resetsAt: rate.resetsAt === null ? null : rate.resetsAt * 1000,
    overageStatus: rate.overageStatus,
    observedAt: now,
  });
}
