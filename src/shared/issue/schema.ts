import { z } from "zod";
import { issueStateSchema, issueStopReasonSchema } from "./state";
import { runStateSchema } from "../events";

export const issueNumberSchema = z.number().int().positive();
export const issuePrioritySchema = z.enum(["high", "medium", "low"]);
export const issueKindSchema = z.enum(["bug", "enhancement", "refactoring", "question"]);
const title = z
  .string()
  .regex(/^[^\r\n]*$/)
  .trim()
  .max(200);
const body = z.string().trim().max(50000);
const dependencies = z
  .array(issueNumberSchema)
  .max(50)
  .transform((values) => [...new Set(values)]);
export const issueInputSchema = z.strictObject({
  title: title.optional(),
  body: body.optional(),
  parentNumber: issueNumberSchema.nullable().optional(),
  dependsOn: dependencies.optional(),
  priority: issuePrioritySchema.nullable().optional(),
  confirmBeforeMerge: z.boolean().optional(),
});
export type IssueInput = z.infer<typeof issueInputSchema>;
export const issueListSchema = z.object({
  state: z.array(issueStateSchema).optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: issueNumberSchema.optional(),
});
export type IssueListInput = z.infer<typeof issueListSchema>;
export const issueToolSchemas = {
  issue_get: z.strictObject({ number: issueNumberSchema }),
  issue_list: z.strictObject({
    state: z.array(issueStateSchema).optional(),
    text: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  issue_create: z.strictObject({
    title: title.min(1),
    body,
    parent: issueNumberSchema.nullable().optional(),
    depends_on: dependencies.optional(),
    priority: issuePrioritySchema.optional(),
    kind: issueKindSchema.optional(),
    confirm_before_merge: z.boolean().optional(),
    designed: z.boolean().optional(),
  }),
  issue_update: z.strictObject({
    number: issueNumberSchema,
    title: title.min(1).optional(),
    body: body.optional(),
    parent: issueNumberSchema.nullable().optional(),
    depends_on: dependencies.optional(),
    priority: issuePrioritySchema.optional(),
    kind: issueKindSchema.optional(),
    confirm_before_merge: z.boolean().optional(),
  }),
  issue_comment: z.strictObject({
    number: issueNumberSchema,
    text: z.string().min(1).max(20000),
  }),
  report_triage: z.strictObject({
    number: issueNumberSchema,
    result: z.enum(["design", "parent"]),
    kind: issueKindSchema,
    urgent: z.boolean().default(false),
    score: z.number().min(0).max(1000).optional(),
    summary: z.string().min(1).max(2000),
  }),
  report_design: z.strictObject({
    number: issueNumberSchema,
    policy: z
      .string()
      .min(1)
      .max(20000)
      .refine((value) => value.trim().length > 0),
    checks: z.array(z.string().max(2000)).max(50),
  }),
  report_needs_human: z.strictObject({
    number: issueNumberSchema,
    questions: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          options: z.array(z.string()).max(10).optional(),
        }),
      )
      .min(1)
      .max(20),
    summary: z.string().max(2000),
  }),
  report_stage: z.strictObject({
    number: issueNumberSchema,
    stage: z.enum(["review", "pr", "merge"]),
  }),
  report_ready_for_merge: z.strictObject({
    number: issueNumberSchema,
    pr_url: z.url().optional(),
    head_sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
    rebased: z.boolean().default(false),
    summary: z.string().max(2000),
  }),
  report_ci_failed: z.strictObject({
    number: issueNumberSchema,
    checks: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          bucket: z.enum(["fail", "cancel", "pending"]),
          link: z.url().optional(),
        }),
      )
      .min(1)
      .max(100),
    timed_out: z.boolean(),
    summary: z.string().max(2000),
  }),
  report_implementation_done: z.strictObject({
    number: issueNumberSchema,
    pr_url: z.url().optional(),
    merge_commit: z.string().regex(/^[a-fA-F0-9]{40}$/),
    summary: z.string().max(2000),
  }),
};
export type IssueToolName = keyof typeof issueToolSchemas;
export const issueRecordSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  number: issueNumberSchema,
  title: z.string(),
  body: z.string(),
  kind: issueKindSchema.nullable(),
  state: issueStateSchema,
  stopReason: issueStopReasonSchema.nullable(),
  parentId: z.string().nullable(),
  priority: issuePrioritySchema.nullable(),
  designed: z.boolean(),
  confirmBeforeMerge: z.boolean(),
  prUrl: z.string().nullable(),
  githubNumber: issueNumberSchema.nullable(),
  createdConversationId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  closedAt: z.number().int().nullable(),
});
export type IssueRecord = z.infer<typeof issueRecordSchema>;
export const issueReferenceSchema = issueRecordSchema.pick({
  id: true,
  number: true,
  title: true,
  state: true,
});
export type IssueReference = z.infer<typeof issueReferenceSchema>;
export const issueViewSchema = issueRecordSchema.omit({ parentId: true }).extend({
  stopDetail: z.string().nullable(),
  createdConversation: z
    .strictObject({ id: z.string(), title: z.string().nullable(), deleted: z.boolean() })
    .nullable(),
  parent: issueReferenceSchema.nullable(),
  children: z.array(issueReferenceSchema),
  dependsOn: z.array(issueReferenceSchema),
  dependents: z.array(issueReferenceSchema),
  conversations: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(["triage", "design", "impl"]),
      runState: runStateSchema,
    }),
  ),
  comments: z.array(
    z.strictObject({ at: z.number().int(), conversationId: z.string(), text: z.string() }),
  ),
});
export type IssueView = z.infer<typeof issueViewSchema>;
export const issueSummarySchema = issueViewSchema.omit({
  body: true,
  children: true,
  dependents: true,
  conversations: true,
  comments: true,
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;
export const issueResponseSchema = z.strictObject({ issue: issueViewSchema });
export const issueListResponseSchema = z.strictObject({
  items: z.array(issueSummarySchema),
  nextCursor: z.string().nullable(),
});
