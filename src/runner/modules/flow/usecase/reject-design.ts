import type { ConversationContent } from "../../../../shared/conversation/api";
import { inputContent } from "../../conversation/usecase/accepted-delivery";
import { err, ok } from "neverthrow";
import { unavailableRunnerError, type DesignRejectionDraft } from "../../../../shared/ipc";
import type { DesignRecord } from "../../../../shared/design/records";
import {
  designEvents,
  designConflict,
  designNotFound,
  designReflecting,
  emptyDesignRejection,
} from "../../../../shared/api/design";
import {
  activeStates,
  type ConversationRuntime,
  type InputAcceptance,
  type SendInput,
} from "../../conversation/usecase/runtime";
import type { Conversation } from "../../conversation/domain/conversation-store";
import type { OutgoingStock, OutgoingStockRepository } from "../../stock/domain/ports";
import { formatStockInstructions } from "../../stock/domain/message-format";
import type { IssueNotice } from "../domain/ports";
import type { DesignFlowDependencies } from "../domain/design-ports";

const prefix =
  "設計レビューで差し戻されました。次の指摘に沿って設計を直し、コミットしてから report_design で報告してください";
class RejectionConflict extends Error {}
function canReject(record: DesignRecord | null, id: string) {
  return (
    record?.issue.state === "design_review" &&
    record.conversation?.id === id &&
    !designEvents(record.events).reflecting
  );
}

export function createRejectDesign(
  deps: DesignFlowDependencies,
  runtime: ConversationRuntime,
  reflecting: (id: string) => boolean,
  stock: OutgoingStockRepository,
  stale: (item: OutgoingStock) => Promise<boolean>,
) {
  async function deliver(
    id: string,
    conversation: Conversation,
    input: SendInput,
    via: "reject" | "message" | "stock",
    acceptance?: InputAcceptance,
    options: {
      callerCancelled?: () => boolean;
      draft?: DesignRejectionDraft;
      stockIds?: readonly string[];
      original?: ConversationContent;
      includeQueued?: boolean;
    } = {},
  ) {
    const conversationId = conversation.id;
    const check = () => {
      if (options.callerCancelled?.()) return unavailableRunnerError;
      if (reflecting(id)) return designReflecting;
      return (
        acceptance?.check?.() ??
        (canReject(deps.repo.read(id), conversationId) ? null : designConflict)
      );
    };
    const unavailable = check();
    if (unavailable) return err(unavailable);
    if (runtime.closing || conversation.closedAt !== null) return err(designConflict);

    let notice: IssueNotice | undefined;
    let draftCleared = false;
    try {
      const delivered = await runtime.deliver(
        conversationId,
        {
          ...input,
          origin: via === "stock" ? "stock" : "developer",
        },
        {
          events: acceptance?.events ?? [],
          check,
          checkBeforeCommit: () =>
            options.callerCancelled?.()
              ? unavailableRunnerError
              : (acceptance?.checkBeforeCommit?.() ?? null),
          before: () => {
            acceptance?.before?.();
            runtime.store.withWorktreeReservation((reservation) => {
              notice = deps.transaction((repo) => {
                const latest = repo.read(id);
                if (!latest || !canReject(latest, conversationId) || reflecting(id))
                  throw new RejectionConflict();
                const now = deps.clock.now();
                if (!repo.move(latest, "design_rejected", now)) throw new RejectionConflict();
                if (options.draft)
                  draftCleared = repo.clearDraft(conversationId, options.draft, now);
                return repo.append(latest, "design_rejected", { via }, now);
              }, reservation);
            });
          },
        },
        {
          includeQueued: options.includeQueued ?? false,
          prefix,
          interrupt: activeStates.includes(conversation.runState),
          afterAcceptance: true,
          acceptedStockIds: options.stockIds,
          acceptedOriginal: options.original,
        },
      );
      if (delivered.isErr()) return err(delivered.error);
      if (notice) deps.notices.publish(notice);
      if (draftCleared) runtime.partsChanged(conversationId, ["draft"]);
      return delivered;
    } catch (error) {
      if (error instanceof RejectionConflict) return err(designConflict);
      throw error;
    }
  }

  runtime.runOptions.registerDesignReview((conversation, input, acceptance, selection) => {
    const { issueId } = conversation;
    if (conversation.kind !== "design" || !issueId || reflecting(issueId)) return;
    const review = deps.repo.read(issueId);
    if (!review || !canReject(review, conversation.id) || !designEvents(review.events).submission)
      return;
    return deliver(issueId, conversation, input, selection ? "stock" : "message", acceptance, {
      stockIds: selection?.ids ?? input.deliveryContext?.stockIds,
      original: selection
        ? undefined
        : input.deliveryContext
          ? input.deliveryContext.original
          : inputContent(input),
      includeQueued: !selection && !input.text && !input.images.length,
    });
  });

  return async (
    id: string,
    input: {
      text: string;
      attachment?: string;
      draft?: DesignRejectionDraft;
    },
    callerCancelled = () => false,
  ) => {
    if (callerCancelled()) return err(unavailableRunnerError);
    const record = deps.repo.read(id);
    if (!record) return err(designNotFound);
    if (reflecting(id) || designEvents(record.events).reflecting) return err(designReflecting);
    const conversationId = record.conversation?.id;
    if (record.issue.state !== "design_review" || !conversationId) return err(designConflict);

    return runtime.serial(
      conversationId,
      async () => {
        const current = runtime.store.get(conversationId);
        if (!current) return err(designConflict);
        const items = stock.list(conversationId).filter(({ kind }) => kind === "instruction");
        const quoted = await Promise.all(
          items.map(async (item) => ({ ...item, stale: await stale(item) })),
        );
        const authoredText = input.text.trim() ? input.text : "";
        const text = [
          items.length ? formatStockInstructions(quoted) : "",
          input.attachment,
          authoredText,
        ]
          .filter((part) => part?.trim())
          .join("\n\n");
        if (!text) return err(emptyDesignRejection);
        const ids = items.map(({ id }) => id);
        const result = await deliver(
          id,
          current,
          { text, origin: "developer", images: [] },
          "reject",
          {
            events: [],
            check: () => {
              const latest = runtime.store.get(conversationId);
              return latest?.cwd === current.cwd && latest.worktreeId === current.worktreeId
                ? null
                : designConflict;
            },
            before: () => {
              const now = deps.clock.now();
              for (const item of items)
                if (!stock.markSent(item, { at: now })) throw new RejectionConflict();
            },
          },
          {
            callerCancelled,
            draft: input.draft?.text === input.text ? input.draft : undefined,
            stockIds: ids,
            original: { text: authoredText, images: [] },
          },
        );
        if (result.isErr()) return err(result.error);
        if (ids.length) runtime.partsChanged(conversationId, ["stock"]);
        return ok({ deliveredStockIds: ids });
      },
      callerCancelled,
    );
  };
}
