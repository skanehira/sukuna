import { z } from "zod";
import { timelineInputCommentSchema } from "./progress/schema";

export const runStateSchema = z.enum([
  "idle",
  "working",
  "waiting_answer",
  "waiting_permission",
  "stopped",
  "failed",
  "usage_limited",
]);
export type RunState = z.infer<typeof runStateSchema>;
export const stopReasonSchema = z.enum([
  "user",
  "restarted",
  "api_error",
  "error",
  "credits_required",
  "usage_limit",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;
export const originSchema = z.enum([
  "developer",
  "queued",
  "interrupt",
  "stock",
  "resume",
  "flow",
  "answer_text",
  "finish_proposal",
]);
export type Origin = z.infer<typeof originSchema>;
export const questionsSchema = z.array(
  z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multi_select: z.boolean(),
  }),
);
export const answersSchema = z.record(
  z.string(),
  z.object({ choices: z.array(z.string()), text: z.string().nullable() }),
);
export type Answers = z.infer<typeof answersSchema>;
export const hunkSchema = z.object({
  old_start: z.number(),
  old_lines: z.number(),
  new_start: z.number(),
  new_lines: z.number(),
  lines: z.array(z.string()),
});
export const diffSchema = z.object({
  tool_use_id: z.string(),
  path: z.string(),
  change: z.enum(["edit", "create", "update"]),
  hunks: z.array(hunkSchema),
  content: z.string().optional(),
  truncated: z.boolean(),
});
const event = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  z.object({ type: z.literal(type), payload, sdkUuid: z.string().nullable().optional() });
export const eventSchema = z.discriminatedUnion("type", [
  event(
    "user_message",
    z.object({
      text: z.string(),
      images: z.array(z.object({ path: z.string(), media_type: z.string() })),
      origin: originSchema,
      timeline_comments: z.array(timelineInputCommentSchema).optional(),
      timeline_legacy_texts: z.array(z.string()).optional(),
      client_ids: z.array(z.string()).optional(),
      queued_ids: z.array(z.string()).optional(),
      client_receipts: z
        .array(
          z.discriminatedUnion("result", [
            z.object({
              client_id: z.string(),
              result: z.literal("queued"),
              queued_id: z.string(),
              received_at: z.number(),
            }),
            z.object({
              client_id: z.string(),
              result: z.literal("delivered"),
              received_at: z.number(),
            }),
          ]),
        )
        .optional(),
    }),
  ),
  event(
    "assistant_text",
    z.object({ text: z.string(), parent_tool_use_id: z.string().nullable() }),
  ),
  event(
    "tool_use",
    z.object({
      tool_use_id: z.string(),
      name: z.string(),
      input: z.unknown(),
      parent_tool_use_id: z.string().nullable(),
    }),
  ),
  event(
    "tool_result",
    z.object({
      tool_use_id: z.string(),
      is_error: z.boolean(),
      content: z.string(),
      truncated: z.boolean(),
      bytes: z.number(),
    }),
  ),
  event("diff", diffSchema),
  event("question", z.object({ request_id: z.string(), questions: questionsSchema })),
  event(
    "answer",
    z.object({ request_id: z.string(), answers: answersSchema, as_message: z.boolean() }),
  ),
  event(
    "permission_request",
    z.object({
      request_id: z.string(),
      tool_name: z.string(),
      input: z.unknown(),
      title: z.string().optional(),
      reason: z.string().optional(),
      blocked_path: z.string().optional(),
    }),
  ),
  event(
    "permission_decision",
    z.object({
      request_id: z.string(),
      behavior: z.enum(["allow", "deny"]),
      message: z.string().optional(),
    }),
  ),
  event(
    "turn_end",
    z.object({
      subtype: z.string(),
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number(),
        cache_read_input_tokens: z.number(),
      }),
      cost_usd: z.number(),
      duration_ms: z.number(),
      permission_denials: z.number(),
      terminal_reason: z.string().optional(),
    }),
  ),
  event(
    "stopped",
    z.object({
      reason: stopReasonSchema,
      detail: z.string().optional(),
      flow_trigger: z.literal("dependency_withdrawn").optional(),
      resets_at: z.number().optional(),
      previous_run_state: runStateSchema.optional(),
    }),
  ),
  event("resumed", z.object({ by: z.enum(["developer", "usage_limit", "flow"]) })),
]);
export type ConversationEvent = z.infer<typeof eventSchema>;
export const assistantResponseEventTypes: readonly ConversationEvent["type"][] = [
  "assistant_text",
  "tool_use",
  "question",
  "permission_request",
];
export function startsAssistantResponse(type: ConversationEvent["type"]): boolean {
  return assistantResponseEventTypes.includes(type);
}
export type StoredEvent = ConversationEvent & {
  conversationId: string;
  seq: number;
  createdAt: number;
};
