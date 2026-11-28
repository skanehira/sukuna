import { err, ok, type Result } from "neverthrow";
import {
  rejectDesignInputSchema,
  designEvents,
  designNotFound,
  designConflict,
  designReflecting,
  emptyDesignRejection,
  type DesignError,
} from "../../../../shared/api/design";
import { sameDraftReceipt } from "../../../../shared/conversation/api";
import type { DesignDependencies } from "../domain/design-ports";

export async function rejectDesign(
  id: string,
  input: unknown,
  deps: DesignDependencies,
): Promise<Result<Response, DesignError>> {
  const parsed = rejectDesignInputSchema.safeParse(input);
  if (!parsed.success)
    return err({ code: "invalid_input", message: "指摘は20,000字以内で書いてください。" });
  const record = deps.read(id);
  if (!record) return err(designNotFound);
  if (record.issue.state !== "design_review") return err(designConflict);
  if (designEvents(record.events).reflecting) return err(designReflecting);
  if (!parsed.data.text.trim() && !record.unsentInstructionCount) return err(emptyDesignRejection);
  const { text, draft: submitted } = parsed.data;
  const stored = record.draft;
  const draft = stored
    ? {
        text: stored.text,
        images: stored.images,
        ...(stored.timelineAnchors ? { timeline_anchors: stored.timelineAnchors } : {}),
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy,
      }
    : null;
  const clearsDraft =
    draft?.text === text &&
    draft.images.length === 0 &&
    (submitted === undefined ||
      (!draft.timeline_anchors?.length && sameDraftReceipt(submitted, draft)));
  const response = await deps.runner.forward(
    "POST",
    `/flow/issues/${encodeURIComponent(id)}/design/reject`,
    {
      text,
      ...(clearsDraft ? { draft } : {}),
    },
  );
  if (!response.ok) return ok(response);
  const body = (await response.json()) as { delivered_stock_ids: string[] };
  return ok(Response.json({ deliveredStockIds: body.delivered_stock_ids }, { status: 202 }));
}
