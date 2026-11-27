import { z } from "zod";
import { hunkSchema, questionsSchema } from "./events";
const stepSchema = z.union([
  z.object({ text: z.string() }),
  z.object({
    tool: z.string(),
    input: z.unknown(),
    result: z.string().default(""),
    diff: z
      .object({
        path: z.string(),
        change: z.enum(["edit", "create", "update"]),
        hunks: z.array(hunkSchema),
        content: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ shell: z.string() }),
  z.object({ ask: questionsSchema }),
  z.object({ permission: z.object({ tool_name: z.string(), input: z.unknown() }) }),
  z.object({ hold: z.literal(true) }),
  z.object({
    rate_limit: z.object({
      status: z.enum(["allowed", "allowed_warning", "rejected"]),
      resetsAt: z.number().nullable().optional(),
      overageStatus: z.string().nullable().optional(),
      errorCode: z.string().nullable().optional(),
    }),
  }),
  z.object({ end: z.string(), terminal_reason: z.string().optional() }),
]);
export const agentScriptSchema = z.object({
  rules: z.array(z.object({ match: z.string(), steps: z.array(stepSchema) })),
  fallback: z.array(stepSchema).optional(),
  completions: z
    .array(z.object({ purpose: z.string(), match: z.string(), text: z.string() }))
    .default([]),
});
export type AgentScript = z.input<typeof agentScriptSchema>;
