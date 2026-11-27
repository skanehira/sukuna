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
  if (!parsed.data.text.trim()) return err(emptyDesignRejection);
  const draft = record.draft;
  const response = await deps.runner.forward(
    "POST",
    `/flow/issues/${encodeURIComponent(id)}/design/reject`,
    {
      ...parsed.data,
      ...(draft?.text === parsed.data.text && draft.images.length === 0
        ? {
            draft: {
              text: draft.text,
              images: draft.images,
              updatedAt: draft.updatedAt,
              updatedBy: draft.updatedBy,
            },
          }
        : {}),
    },
  );
  if (!response.ok) return ok(response);
  const body = (await response.json()) as { delivered_stock_ids: string[] };
  return ok(Response.json({ deliveredStockIds: body.delivered_stock_ids }, { status: 202 }));
}
