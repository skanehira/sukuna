import { stockSendReceipt } from "../../../../shared/stock-send-receipts";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createWorkspaceDependencies } from "../../../../server/modules/workspace/adapter/dependencies";
import { readFile } from "../../../../server/modules/workspace/usecase/read-file";
import { isStale } from "../../../../server/modules/stock/domain/staleness";
import type { OutgoingStock } from "../domain/ports";
import {
  conflict,
  InputRefused,
  type ConversationRuntime,
} from "../../conversation/usecase/runtime";
import { formatStockInstructions } from "../domain/message-format";
import { stockChanged } from "../usecase/stock-send-refused";
import { err, ok } from "neverthrow";
import { createSendStock } from "../usecase/send-stock";
import { createOutgoingStockRepository } from "./outgoing-stock-repository";

export function createStockQuoteCheck(db: OpenedDatabase["db"]) {
  const workspace = createWorkspaceDependencies(() => db);
  return async ({ quote, conversationId }: OutgoingStock) => {
    if (quote.kind !== "file") return false;
    const result = await readFile(conversationId, quote.path, workspace);
    return isStale(
      quote,
      result.isOk() && result.value.kind === "text" ? result.value.content : undefined,
    );
  };
}

export function createStockSender(db: OpenedDatabase["db"], runtime: ConversationRuntime) {
  const repository = createOutgoingStockRepository(db);
  const stale = createStockQuoteCheck(db);
  runtime.runOptions.registerStockBatch(async (conversation, selection) => {
    if (conversation.kind === "thread")
      return err(conflict("スレッドからはストックを送れません。"));
    const ids = new Set(selection);
    const items = repository
      .list(conversation.id)
      .filter((item) => item.kind === "instruction" && ids.has(item.id));
    if (items.length !== ids.size) return err(stockChanged);
    const quoted = await Promise.all(
      items.map(async (item) => ({ ...item, stale: await stale(item) })),
    );
    const sameWorkspace = () => {
      const current = runtime.store.get(conversation.id);
      return current?.cwd === conversation.cwd && current.worktreeId === conversation.worktreeId;
    };
    return ok({
      text: formatStockInstructions(quoted),
      ids: items.map(({ id }) => id),
      check: () => (sameWorkspace() ? null : stockChanged),
      commit() {
        const at = runtime.options.clock.now();
        for (const item of items)
          if (!repository.markSent(item, { at })) throw new InputRefused(stockChanged);
      },
    });
  });
  return createSendStock({
    runtime,
    repository,
    receipt: (attemptId, conversationId) => stockSendReceipt(db, attemptId, conversationId),
    stale,
  });
}
