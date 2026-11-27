import { z } from "zod";
import { runStateSchema } from "./events";
import { issueStateSchema } from "./issue/state";

export const closeWhileWorkingMessage = "AI が作業中です。止めて閉じるか、やめてください";
export const closeConversationSchema = z.object({ stopIfWorking: z.boolean().default(false) });
export const searchLifecycleQuerySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
export const listedConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  runState: runStateSchema,
  closedAt: z.number().nullable(),
  lastActivityAt: z.number(),
});
const listedIssueSchema = z.object({ id: z.string(), number: z.number(), title: z.string() });
export const projectConversationsSchema = z.object({
  conversations: listedConversationSchema
    .extend({ threads: z.array(listedConversationSchema) })
    .array(),
  issueThreads: z.array(
    z.object({ issue: listedIssueSchema, threads: z.array(listedConversationSchema) }),
  ),
});
const searchConversation = listedConversationSchema.extend({
  type: z.literal("conversation"),
  projectId: z.string(),
});
export const lifecycleSearchResponseSchema = z.object({
  results: z
    .union([
      listedIssueSchema.extend({
        type: z.literal("issue"),
        projectId: z.string(),
        state: issueStateSchema,
        lastActivityAt: z.number(),
      }),
      searchConversation.extend({ kind: z.literal("chat") }),
      searchConversation.extend({ kind: z.literal("thread"), parentId: z.string() }),
    ])
    .array(),
  truncated: z.boolean(),
});
const failureSchema = z.object({ ok: z.literal(false), error: z.string() });
const available = <S extends z.ZodRawShape>(fields: S) =>
  z.union([z.object({ ...fields, ok: z.literal(true) }), failureSchema]);
const items = <S extends z.ZodType>(item: S) => available({ items: z.array(item) });
const limitedItems = <S extends z.ZodType>(item: S) =>
  available({ items: z.array(item), more: z.number() });
export const closingIssueSchema = listedIssueSchema.extend({ state: issueStateSchema });
export const closingCommitSchema = z.object({ hash: z.string(), subject: z.string() });
export const closingPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
});
export const closingSummarySchema = z.object({
  working: z.boolean(),
  outputs: z.object({
    issues: items(closingIssueSchema),
    files: items(z.string()),
    commits: limitedItems(closingCommitSchema).optional(),
    prs: items(closingPrSchema).optional(),
  }),
  remaining: z.object({
    uncommitted: limitedItems(z.string()).optional(),
    unpushed: available({ count: z.number(), upstream: z.boolean() }).optional(),
    stock: z.object({ questions: z.number(), instructions: z.number() }),
    runningThreads: listedConversationSchema
      .pick({ id: true, title: true, runState: true })
      .array(),
  }),
  git: z.boolean(),
});
export type ListedConversation = z.infer<typeof listedConversationSchema>;
export type ProjectConversations = z.infer<typeof projectConversationsSchema>;
export type LifecycleSearchResponse = z.infer<typeof lifecycleSearchResponseSchema>;
export type SearchResult = LifecycleSearchResponse["results"][number];
export type ClosingIssue = z.infer<typeof closingIssueSchema>;
export type ClosingSummary = z.infer<typeof closingSummarySchema>;
