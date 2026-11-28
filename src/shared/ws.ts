import { z } from "zod";
import { runStateSchema, stopReasonSchema, eventSchema } from "./events";

export const topicSchema = z.string().regex(/^(?:inbox|app|(?:conversation|issue):[^:]+)$/);
export const clientMessageSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("subscribe"),
    topic: topicSchema,
    after: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("unsubscribe"), topic: topicSchema }),
  z.object({ op: z.literal("shown"), topics: z.array(topicSchema) }),
  z.object({ op: z.literal("visibility"), visible: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const conversationEventSchema = z.intersection(
  eventSchema,
  z.object({
    conversation_id: z.string(),
    seq: z.number().int().positive(),
    created_at: z.number(),
    sdk_uuid: z.string().nullable(),
  }),
);
const issueEventSchema = z.object({
  issue_id: z.string(),
  seq: z.number().int().positive(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.number(),
});
const noticeSchema = z.object({
  level: z.enum(["info", "error"]),
  message: z.string(),
  conversation_id: z.string().optional(),
  issue_id: z.string().optional(),
  notification: z.object({ tag: z.string(), url: z.string() }).optional(),
});
export const serverMessageSchema = z
  .object({ topic: topicSchema, seq: z.number().int().nonnegative() })
  .and(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("event"),
        payload: z.union([conversationEventSchema, issueEventSchema]),
      }),
      z.object({ type: z.literal("delta"), payload: z.object({ text: z.string() }) }),
      z.object({
        type: z.literal("output_tokens"),
        payload: z.object({ tokens: z.number().int().nonnegative() }),
      }),
      z.object({
        type: z.literal("state"),
        payload: z.object({
          run_state: runStateSchema,
          stop_reason: stopReasonSchema.nullable(),
          resets_at: z.number().nullable(),
        }),
      }),
      z.object({
        type: z.literal("changed"),
        payload: z.object({
          parts: z
            .array(z.enum(["queue", "answers", "draft", "recap", "stock", "threads", "timeline"]))
            .optional(),
          conversation_ids: z.array(z.string()).optional(),
          issue_ids: z.array(z.string()).optional(),
          project_ids: z.array(z.string()).optional(),
        }),
      }),
      z.object({
        type: z.literal("resync"),
        payload: z.object({ last_seq: z.number().int().nonnegative() }),
      }),
      z.object({ type: z.literal("notice"), payload: noticeSchema }),
      z.object({ type: z.literal("ping"), payload: z.object({}) }),
      z.object({ type: z.literal("runner"), payload: z.object({ connected: z.boolean() }) }),
      z.object({ type: z.literal("settings_changed"), payload: z.record(z.string(), z.unknown()) }),
    ]),
  );
export type ServerMessage = z.infer<typeof serverMessageSchema>;
