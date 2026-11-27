import { err, ok, type Result } from "neverthrow";
import {
  designEvents,
  designSubmittedSchema,
  designApprovalEventSchema,
  designReflectedEventSchema,
  designPrCreatedSchema,
  designFailureSchema,
  designNotFound,
  type DesignError,
  type DesignResponse,
} from "../../../../shared/api/design";
import { designStatus } from "../domain/design-status";
import type { DesignDependencies } from "../domain/design-ports";

export async function getDesign(
  id: string,
  deps: DesignDependencies,
): Promise<Result<DesignResponse, DesignError>> {
  const record = deps.read(id);
  if (!record) return err(designNotFound);
  const history = designEvents(record.events);
  const selection = designSubmittedSchema.safeParse(history.submission?.payload);
  const approval = designApprovalEventSchema.safeParse(history.approval?.payload);
  const reflection = designReflectedEventSchema.safeParse(history.reflected?.payload);
  const pr = designPrCreatedSchema.safeParse(history.pr?.payload);
  const failure = designFailureSchema.safeParse(history.failure?.payload);
  const diff = selection.success
    ? await deps.git.diff(record.project.path, selection.data.baseCommit, selection.data.headCommit)
    : [];
  return ok({
    issueId: id,
    state: record.issue.state,
    status: designStatus(record.issue.state, record.events),
    designConversationId: record.conversation?.id ?? null,
    submittedAt: history.submission?.createdAt ?? null,
    policy: selection.data?.policy ?? null,
    checks: selection.data?.checks ?? [],
    headCommit: selection.data?.headCommit ?? null,
    files: diff ?? [],
    ...(diff === null
      ? {
          diffError:
            "設計のコミットが見つかりません。差し戻して、AI に設計の完了を報告し直させてください",
        }
      : {}),
    reflection: {
      mode: reflection.data?.mode ?? approval.data?.mode ?? null,
      prUrl: reflection.data?.prUrl ?? pr.data?.prUrl ?? null,
      failure: failure.data?.message ?? null,
      reflectedCommit: reflection.data?.commit ?? null,
    },
    unsentInstructionCount: record.unsentInstructionCount,
  });
}
