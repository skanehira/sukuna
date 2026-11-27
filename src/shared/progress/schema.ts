import { z } from "zod";

export const taskStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);
const shareSchema = z.strictObject({
  pending: z.number(),
  in_progress: z.number(),
  completed: z.number(),
  blocked: z.number(),
});
const leavesSchema = shareSchema.extend({ total: z.number() });
export const taskOpSchema = z.object({
  op: z.enum(["add", "update", "remove"]),
  id: z.string(),
  parent: z.string().optional(),
  title: z.string().optional(),
  status: taskStatusSchema.optional(),
  weight: z.number().optional(),
  description: z.string().optional(),
  note: z.string().optional(),
  done: z.array(z.number()).optional(),
});
export const timelineCommentSchema = z.strictObject({
  at: z.number(),
  taskId: z.string(),
  text: z.string(),
});
export const timelineInputCommentSchema = z.strictObject({
  task_id: z.string(),
  text: z.string(),
});
export const unresolvedTimelineCommentSchema = z.strictObject({
  at: z.number(),
  text: z.string(),
  reason: z.enum(["ambiguous_task", "ambiguous_boundary"]),
});
export const timelineFileSchema = z.object({
  version: z.literal(1),
  journal: z.array(
    z.object({
      at: z.number(),
      toolUseId: z.string(),
      agentId: z.string().optional(),
      ops: z.array(taskOpSchema),
    }),
  ),
  reports: z.array(z.strictObject({ at: z.number(), text: z.string() })),
  comments: z.array(timelineCommentSchema).default([]),
});
const taskSchema = z.strictObject({
  id: z.string(),
  parent: z.string().nullable(),
  title: z.string(),
  status: taskStatusSchema,
  weight: z.number(),
  description: z.string().optional(),
  note: z.string().optional(),
  done: z.tuple([z.number(), z.number()]).optional(),
  completed: z.number(),
  units: z.string(),
});
export const timelineSchema = z.strictObject({
  defaultTreeId: z.string().nullable(),
  trees: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      status: taskStatusSchema,
      completed: z.number(),
      parts: shareSchema,
      leaves: leavesSchema,
      startedAt: z.number().nullable(),
    }),
  ),
  tasks: z.array(taskSchema),
  history: z.array(
    z.strictObject({
      at: z.number(),
      taskId: z.string(),
      title: z.string(),
      from: taskStatusSchema.nullable(),
      to: taskStatusSchema,
      weight: z.number(),
      completedBefore: z.number(),
      completedAfter: z.number(),
      description: z.string().nullable(),
      note: z.string().nullable(),
      agentId: z.string().nullable(),
    }),
  ),
  reports: z.array(z.strictObject({ at: z.number(), text: z.string() })),
  comments: z.array(timelineCommentSchema),
  unresolvedComments: z.array(unresolvedTimelineCommentSchema),
});
export const progressResponseSchema = z.strictObject({
  conversationId: z.string().nullable(),
  activity: z
    .strictObject({
      stage: z.enum(["reply", "triage", "design", "implement", "review", "pr", "ci", "merge"]),
      stageLabel: z.string(),
      stageStartedAt: z.number(),
      lastAction: z.string(),
      lastActionAt: z.number().nullable(),
    })
    .nullable(),
  timeline: timelineSchema.nullable(),
  readError: z.string().nullable(),
});
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskOp = z.infer<typeof taskOpSchema>;
export type TimelineFile = z.infer<typeof timelineFileSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineComment = z.infer<typeof timelineCommentSchema>;
export type TimelineInputComment = z.infer<typeof timelineInputCommentSchema>;
export type UnresolvedTimelineComment = z.infer<typeof unresolvedTimelineCommentSchema>;
export type ProgressResponse = z.infer<typeof progressResponseSchema>;
