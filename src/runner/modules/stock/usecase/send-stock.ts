import { prepareAcceptance } from "../../conversation/usecase/run-options";
import type { StockSendIpcInput } from "../../../../shared/ipc";
import type { StockSendReceipt } from "../../../../shared/stock-send-receipts";
import { err, ok, type Result } from "neverthrow";
import type { StockSendResponse } from "../../../../shared/stock";
import {
  activeStates,
  conflict,
  type ConversationRuntime,
  type DeliveryError,
  type OperationError,
} from "../../conversation/usecase/runtime";
import { withConversationAdmission } from "../../conversation/usecase/start";
import type { Conversation } from "../../conversation/domain/conversation-store";
import { formatStockInstructions, formatStockItem } from "../domain/message-format";
import type { OutgoingStock, OutgoingStockRepository } from "../domain/ports";
import { canForkStockHistory, startStockThread } from "./start-stock-thread";
import { cancelledStockSend, stockChanged, StockSendRefused } from "./stock-send-refused";

export type SendStockDependencies = {
  runtime: ConversationRuntime;
  repository: OutgoingStockRepository;
  stale(item: OutgoingStock): Promise<boolean>;
  receipt(attemptId: string, conversationId: string): StockSendReceipt;
};

export function createSendStock(deps: SendStockDependencies) {
  const { runtime, repository } = deps;
  return (id: string, input: StockSendIpcInput, cancelled: () => boolean) => {
    const sendInConversation = async (
      parent: Conversation,
    ): Promise<Result<StockSendResponse, DeliveryError>> => {
      if (parent.kind === "thread") return err(conflict("スレッドからはストックを送れません。"));
      if (runtime.closing) return err(cancelledStockSend);
      const receipt = input.attempt_id ? deps.receipt(input.attempt_id, id) : undefined;
      const ids = input.stockIds === undefined ? undefined : new Set(input.stockIds);
      const selected = repository.list(id).filter((item) => ids === undefined || ids.has(item.id));
      const questions =
        input.kinds === "instructions" ? [] : selected.filter((item) => item.kind === "question");
      const instructions =
        input.kinds === "questions" ? [] : selected.filter((item) => item.kind === "instruction");
      if (
        receipt &&
        !runtime.store.transaction(
          () => !cancelled() && !runtime.closing && receipt.start(questions.map(({ id }) => id)),
        )
      )
        return err(cancelledStockSend);
      const expired = () => cancelled() || runtime.closing || receipt?.isActive() === false;
      const sourceSession =
        questions.length && canForkStockHistory(runtime, parent) ? parent.sessionId : null;
      const delivery =
        instructions.length > 0
          ? await sendInstructions(parent, instructions, deps, expired, receipt)
          : ok<null, DeliveryError>(null);
      if (delivery.isErr()) return err(delivery.error);
      const source = runtime.store.get(id) ?? parent;
      const results: StockSendResponse["questions"] = [];
      for (const question of questions) {
        if (expired()) return err(cancelledStockSend);
        const outcome = await startStockThread(
          runtime,
          repository,
          { ...source, sessionId: sourceSession },
          question,
          await deps.stale(question),
          expired,
          receipt,
        );
        if (!outcome.ok && receipt)
          runtime.store.transaction(() => {
            if (!expired()) receipt.question(outcome);
          });
        results.push(outcome);
      }
      if (expired()) return err(cancelledStockSend);
      return ok({
        instructions: { count: instructions.length, delivery: delivery.value },
        questions: results,
      });
    };
    return withConversationAdmission(runtime, id, "stock", cancelled, sendInConversation);
  };
}

async function sendInstructions(
  parent: Conversation,
  items: OutgoingStock[],
  deps: SendStockDependencies,
  cancelled: () => boolean,
  receipt: StockSendReceipt | undefined,
): Promise<Result<"delivered" | "queued", DeliveryError>> {
  const { runtime, repository } = deps;
  const id = parent.id;
  const withStaleQuotes = async () => {
    const itemsWithStaleQuotes: OutgoingStock[] = [];
    for (const item of items) {
      if (cancelled() || runtime.closing) throw new StockSendRefused(cancelledStockSend);
      itemsWithStaleQuotes.push({ ...item, stale: await deps.stale(item) });
    }
    return itemsWithStaleQuotes;
  };
  const sameWorkspace = (a: Conversation | null, b: Conversation) =>
    a?.cwd === b.cwd && a.worktreeId === b.worktreeId;
  let current = parent;
  const check = (): OperationError | null => {
    if (cancelled() || runtime.closing) return cancelledStockSend;
    if (!sameWorkspace(runtime.store.get(id), current)) return stockChanged;
    return null;
  };
  const verify = () => {
    const failure = check();
    if (failure) throw new StockSendRefused(failure);
  };
  const markSent = (item: OutgoingStock, now: number, seq?: number) => {
    if (!repository.markSent(item, { at: now, seq })) throw new StockSendRefused(stockChanged);
  };
  let release: (() => void) | undefined;
  try {
    let messages = await withStaleQuotes();
    const input = { text: formatStockInstructions(messages), origin: "stock" as const, images: [] };
    verify();
    const allowed = await runtime.runOptions.allowDelivery(parent, input);
    if (allowed.isErr()) return err(allowed.error);
    const afterGuard = runtime.store.get(id);
    if (!afterGuard) return err({ code: "not_found", message: "会話が見つかりません。" });
    if (!sameWorkspace(afterGuard, current)) {
      current = afterGuard;
      messages = await withStaleQuotes();
      input.text = formatStockInstructions(messages);
    }
    verify();
    current = runtime.store.get(id)!;
    if (activeStates.includes(current.runState)) {
      const queuedIds = messages.map(() => runtime.options.id());
      const prepared = runtime.runOptions.prepareQueue(current, input, cancelled, queuedIds);
      if (prepared.isErr()) return err(prepared.error);
      try {
        runtime.record(
          id,
          [],
          () => {
            verify();
            prepared.value.before?.();
            const now = runtime.options.clock.now();
            const last = runtime.store.queue(id).at(-1)?.position ?? 0;
            for (const [index, item] of messages.entries()) {
              markSent(item, now);
              runtime.store.enqueue({
                id: queuedIds[index]!,
                conversationId: id,
                stockItemId: item.id,
                text: formatStockItem(item),
                images: [],
                position: last + index + 1,
                clientId: null,
                createdAt: now,
              });
            }
            receipt?.instructions(
              { count: messages.length, delivery: "queued" },
              runtime.store.get(id)?.closedAt ?? null,
            );
          },
          undefined,
          verify,
        );
      } catch (error) {
        prepared.value.rejected?.();
        throw error;
      }
      prepared.value.committed?.();
      runtime.partsChanged(id, ["queue", "stock"]);
      return ok("queued");
    }
    const prepared = await runtime.runOptions.prepareDelivery(current, input, "message", cancelled);
    if (prepared.isErr()) return err(prepared.error);
    const { input: instruction, committed, rejected, prefix } = prepared.value;
    release = prepared.value.release;
    current = runtime.store.get(id) ?? current;
    const result = await runtime.deliver(
      id,
      instruction,
      prepareAcceptance(prepared.value, {
        events: [],
        check,
        checkBeforeCommit: () => {
          if (cancelled() || runtime.closing) return cancelledStockSend;
          const workspace = prepared.value.workspace;
          const latest = runtime.store.get(id);
          return workspace
            ? latest?.cwd === workspace.path && latest.worktreeId === workspace.id
              ? null
              : stockChanged
            : check();
        },
        before: () => {
          const now = runtime.options.clock.now();
          const next = (runtime.store.get(id)?.lastSeq ?? 0) + 1;
          items.forEach((item) => markSent(item, now, next));
          receipt?.instructions(
            { count: items.length, delivery: "delivered" },
            runtime.store.get(id)?.closedAt ?? null,
          );
        },
      }),
      { reopensAfterAcceptance: "stock", prefix, checkStage: "owner" },
    );
    if (result.isErr()) {
      rejected?.();
      return err(result.error);
    }
    committed?.();
    runtime.partsChanged(id, ["stock"]);
    return ok(result.value.result);
  } catch (error) {
    if (error instanceof StockSendRefused) return err(error.error);
    throw error;
  } finally {
    release?.();
  }
}
