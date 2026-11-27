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
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
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
) {
  return async (
    id: string,
    input: {
      text: string;
      attachment?: string;
      via?: "reject" | "message" | "stock";
      draft?: DesignRejectionDraft;
    },
    callerCancelled = () => false,
  ) => {
    if (callerCancelled()) return err(unavailableRunnerError);
    const via = input.via ?? "reject";
    if (!input.text.trim() && !input.attachment?.trim()) return err(emptyDesignRejection);
    const record = deps.repo.read(id);
    if (!record) return err(designNotFound);
    if (reflecting(id) || designEvents(record.events).reflecting) return err(designReflecting);
    const conversationId = record.conversation?.id;
    if (record.issue.state !== "design_review" || !conversationId) return err(designConflict);

    const text = [prefix, input.attachment, input.text].filter((part) => part?.trim()).join("\n\n");
    return runtime.serial(
      conversationId,
      async () => {
        const current = runtime.store.get(conversationId);
        if (!current || runtime.closing || current.closedAt !== null) return err(designConflict);
        const check = () => {
          if (callerCancelled()) return unavailableRunnerError;
          if (reflecting(id)) return designReflecting;
          return canReject(deps.repo.read(id), conversationId) ? null : designConflict;
        };
        const unavailable = check();
        if (unavailable) return err(unavailable);
        let notice: IssueNotice | undefined;
        let draftCleared = false;
        try {
          const delivered = await runtime.deliver(
            conversationId,
            {
              text,
              images: [],
              origin: via === "stock" ? "stock" : "developer",
            },
            {
              events: [],
              check,
              checkBeforeCommit: () => (callerCancelled() ? unavailableRunnerError : null),
              before: () =>
                runtime.store.withWorktreeReservation((reservation) => {
                  const repoNotice = deps.transaction((repo) => {
                    const latest = repo.read(id);
                    if (!latest || !canReject(latest, conversationId) || reflecting(id))
                      throw new RejectionConflict();
                    const now = deps.clock.now();
                    if (!repo.move(latest, "design_rejected", now)) throw new RejectionConflict();
                    if (via === "reject" && input.draft?.text === input.text)
                      draftCleared = repo.clearDraft(conversationId, input.draft, now);
                    return repo.append(latest, "design_rejected", { via }, now);
                  }, reservation);
                  notice = repoNotice;
                }),
            },
            {
              includeQueued: false,
              interrupt: activeStates.includes(current.runState),
              afterAcceptance: true,
            },
          );
          if (delivered.isErr()) return err(delivered.error);
        } catch (error) {
          if (error instanceof RejectionConflict) return err(designConflict);
          throw error;
        }
        if (notice) deps.notices.publish(notice);
        if (draftCleared) runtime.partsChanged(conversationId, ["draft"]);
        return ok({ deliveredStockIds: [] as string[] });
      },
      callerCancelled,
    );
  };
}
