import { stockSendReceipt } from "../../../../shared/stock-send-receipts";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createWorkspaceDependencies } from "../../../../server/modules/workspace/adapter/dependencies";
import { readFile } from "../../../../server/modules/workspace/usecase/read-file";
import { isStale } from "../../../../server/modules/stock/domain/staleness";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import { createSendStock } from "../usecase/send-stock";
import { createOutgoingStockRepository } from "./outgoing-stock-repository";

export function createStockSender(db: OpenedDatabase["db"], runtime: ConversationRuntime) {
  const workspace = createWorkspaceDependencies(() => db);
  return createSendStock({
    runtime,
    repository: createOutgoingStockRepository(db),
    receipt: (attemptId, conversationId) => stockSendReceipt(db, attemptId, conversationId),
    stale: async ({ quote, conversationId }) => {
      if (quote.kind !== "file") return false;
      const result = await readFile(conversationId, quote.path, workspace);
      return isStale(
        quote,
        result.isOk() && result.value.kind === "text" ? result.value.content : undefined,
      );
    },
  });
}
