import { z } from "zod";
import { answersSchema, originSchema, runStateSchema } from "./events";
import { timelineInputCommentSchema } from "./progress/schema";

export const startConversationSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(["chat", "triage", "design", "impl", "thread"]),
  cwd: z.string().min(1),
  title: z.string(),
  message: z.string().optional(),
  worktree_id: z.string().nullable().optional(),
  issue_id: z.string().nullable().optional(),
  parent_conversation_id: z.string().nullable().optional(),
});
export const sendMessageSchema = z.object({
  text: z.string(),
  images: z.array(z.string()),
  interrupt: z.boolean(),
  client_id: z.string().min(1),
  origin: originSchema,
  timeline_comments: z.array(timelineInputCommentSchema).optional(),
});
export const forkConversationSchema = z.object({ title: z.string(), kind: z.literal("thread") });
export const answerSchema = z.object({ request_id: z.string(), answers: answersSchema });
export const permissionSchema = z.object({
  behavior: z.enum(["allow", "deny"]),
  message: z.string().optional(),
});
export const workspaceSchema = z.object({
  cwd: z.string().min(1),
  worktree_id: z.string().nullable().optional(),
});
export const flowNotifySchema = z.object({
  project_id: z.string().optional(),
  issue_id: z.string().optional(),
});
export const runnerNoticeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversation_id: z.string(),
    seq: z.number().int().nonnegative(),
    run_state: runStateSchema,
    project_id: z.string(),
    issue_id: z.string().nullable(),
  }),
  z.object({ kind: z.literal("delta"), conversation_id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("conversation_parts"),
    conversation_id: z.string(),
    parts: z.array(z.enum(["queue", "answers", "recap", "stock", "threads"])),
  }),
  z.object({
    kind: z.literal("issue"),
    issue_id: z.string(),
    project_id: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("project"), project_id: z.string() }),
  z.object({
    kind: z.literal("notice"),
    level: z.enum(["info", "error"]),
    message: z.string(),
    conversation_id: z.string().optional(),
    issue_id: z.string().optional(),
  }),
]);
export type RunnerNotice = z.infer<typeof runnerNoticeSchema>;
