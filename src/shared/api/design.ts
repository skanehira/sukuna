import { z } from "zod";
import { issueStateSchema } from "../issue/state";

export const designCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const designModeSchema = z.enum(["direct", "pr", "none"]);
export const designSubmittedSchema = z.object({
  policy: z.string(),
  checks: z.array(z.string()),
  branch: z.string(),
  baseCommit: designCommitSchema,
  headCommit: designCommitSchema,
});
export const designApprovalEventSchema = z.object({
  headCommit: designCommitSchema,
  mode: designModeSchema,
});
export const designReflectedEventSchema = z.object({
  mode: designModeSchema,
  commit: designCommitSchema.nullable(),
  prUrl: z.string().nullable(),
});
export const designPrCreatedSchema = z.object({ prUrl: z.string() });
export const designFailureSchema = z.object({ message: z.string() });
export const designStatusSchema = z.enum([
  "none",
  "designing",
  "reviewing",
  "reflecting",
  "merging_pr",
  "merge_failed",
  "approved",
]);
export const designFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  binary: z.boolean(),
  hunks: z.array(
    z.object({
      oldStart: z.number().int().nonnegative(),
      oldLines: z.number().int().nonnegative(),
      newStart: z.number().int().nonnegative(),
      newLines: z.number().int().nonnegative(),
      lines: z.array(
        z.object({
          kind: z.enum(["add", "del", "ctx"]),
          oldNo: z.number().int().positive().nullable(),
          newNo: z.number().int().positive().nullable(),
          text: z.string(),
        }),
      ),
    }),
  ),
});
export const designResponseSchema = z.object({
  issueId: z.string(),
  state: issueStateSchema,
  status: designStatusSchema,
  designConversationId: z.string().nullable(),
  submittedAt: z.number().nullable(),
  policy: z.string().nullable(),
  checks: z.array(z.string()),
  headCommit: designCommitSchema.nullable(),
  files: z.array(designFileSchema),
  diffError: z.string().optional(),
  reflection: z.object({
    mode: designModeSchema.nullable(),
    prUrl: z.string().nullable(),
    failure: z.string().nullable(),
    reflectedCommit: designCommitSchema.nullable(),
  }),
  unsentInstructionCount: z.number().int().nonnegative(),
});
export const approveDesignInputSchema = z.strictObject({ headCommit: designCommitSchema });
export const rejectDesignInputSchema = z.strictObject({ text: z.string().max(20_000) });
export const approveDesignResponseSchema = z.object({ status: z.literal("reflecting") });
export const rejectDesignResponseSchema = z.object({ deliveredStockIds: z.array(z.string()) });
export type DesignResponse = z.infer<typeof designResponseSchema>;
export type DesignFile = z.infer<typeof designFileSchema>;
export type DesignSubmission = z.infer<typeof designSubmittedSchema>;
export type DesignStatus = z.infer<typeof designStatusSchema>;

export type DesignEvent = { seq: number; type: string; payload: unknown; createdAt: number };

export function designEvents(events: DesignEvent[]) {
  const latest = (type: string) =>
    events.reduce<DesignEvent | undefined>(
      (found, event) => (event.type === type && event.seq > (found?.seq ?? -1) ? event : found),
      undefined,
    );
  const submission = latest("design_submitted");
  const approval = latest("design_approved");
  const reflected = latest("design_reflected");
  const failure = latest("design_reflect_failed");
  const pr = latest("design_pr_created");
  const rejection = latest("design_rejected");
  const version = Math.max(submission?.seq ?? 0, rejection?.seq ?? 0);
  const currentApproval = (approval?.seq ?? 0) > version ? approval : undefined;
  const currentReflection =
    currentApproval && (reflected?.seq ?? 0) > currentApproval.seq ? reflected : undefined;
  const currentFailure =
    currentApproval && (failure?.seq ?? 0) > currentApproval.seq ? failure : undefined;
  const currentPr = currentApproval && (pr?.seq ?? 0) > currentApproval.seq ? pr : undefined;
  return {
    submission,
    approval: currentApproval,
    reflected: currentReflection,
    failure: currentFailure,
    pr: currentPr,
    reflecting:
      currentApproval !== undefined && !currentReflection && !currentFailure && !currentPr,
  };
}

export type DesignError = {
  code: "not_found" | "invalid_input" | "conflict" | "runner_unavailable" | "internal";
  message: string;
};
export const designNotFound = {
  code: "not_found",
  message: "issue がありません。開き直してください。",
} satisfies DesignError;
export const designConflict = {
  code: "conflict",
  message: "issue の状態が変わりました。読み直してから、もう一度操作してください。",
} satisfies DesignError;
export const designReflecting = {
  code: "conflict",
  message: "設計書を反映しています。完了してから、もう一度操作してください。",
} satisfies DesignError;
export const designStale = {
  code: "conflict",
  message: "表示した後に設計が変わりました。読み直してから承認してください",
} satisfies DesignError;
export const emptyDesignRejection = {
  code: "invalid_input",
  message: "指摘を書くか、指示をストックしてから差し戻してください",
} satisfies DesignError;
