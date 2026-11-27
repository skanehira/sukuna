import { z } from "zod";
import { changeHunkSchema } from "../files";
export const prFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  binary: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(changeHunkSchema),
});
export type PrFile = z.infer<typeof prFileSchema>;
export const checkSchema = z.object({
  name: z.string(),
  kind: z.enum(["check_run", "status_context"]),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  state: z.string().nullable(),
  outcome: z.enum(["success", "skipped", "failure", "cancelled", "running", "queued", "other"]),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  detailsUrl: z.string().nullable(),
});
export type PrCheck = z.infer<typeof checkSchema>;
export const prInfoSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headSha: z.string(),
  baseRefName: z.string(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  mergedAt: z.number().nullable(),
});
export const prResponseSchema = z.object({
  issueId: z.string(),
  source: z.enum(["github", "local", "none"]),
  pr: prInfoSchema.nullable(),
  checks: z.array(checkSchema),
  evidence: z.object({
    markdown: z.string(),
    images: z.array(z.object({ alt: z.string(), url: z.string() })),
  }),
  files: z.array(prFileSchema),
  local: z.object({ branch: z.string(), baseBranch: z.string(), headSha: z.string() }).nullable(),
  diffTooLarge: z.boolean(),
  earlierPrUrls: z.array(z.string()),
  fetchedAt: z.number(),
  fetchError: z.string().nullable(),
  waitingMergeConfirm: z.boolean(),
  implConversationId: z.string().nullable(),
  worktree: z.object({ id: z.string(), path: z.string() }).nullable(),
  unsentInstructionCount: z.number().int().nonnegative(),
});
export type PrResponse = z.infer<typeof prResponseSchema>;
export const allowMergeSchema = z.strictObject({ headSha: z.string().regex(/^[a-f0-9]{40}$/i) });
export const publishCommentsSchema = z.strictObject({
  stockIds: z.array(z.string().min(1)).min(1).max(50),
});
export const publishResponseSchema = z.object({
  reviewUrl: z.string(),
  published: z.array(
    z.object({ stockId: z.string(), url: z.string(), placement: z.enum(["line", "body"]) }),
  ),
  skipped: z.array(
    z.object({
      stockId: z.string(),
      reason: z.enum(["question", "already_published", "not_in_conversation"]),
    }),
  ),
});
export type PublishResponse = z.infer<typeof publishResponseSchema>;

export const allowMergeResponseSchema = z.object({ state: z.literal("implementing") });
