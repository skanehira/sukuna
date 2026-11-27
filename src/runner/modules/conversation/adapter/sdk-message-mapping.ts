import { z } from "zod";
import type { AgentOutput, DiffOutput } from "../domain/agent-port";

const blockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});
const patchSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
const diffResultSchema = z
  .looseObject({
    type: z.enum(["edit", "create", "update"]).optional(),
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    content: z.string().optional(),
    structuredPatch: z.array(patchSchema).optional(),
  })
  .refine((result) => Boolean(result.filePath || result.file_path));
const messageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  error: z.string().optional(),
  message: z.object({ content: z.array(blockSchema) }).optional(),
  slash_commands: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  event: z
    .object({
      type: z.string(),
      delta: z.object({ type: z.string(), text: z.string().optional() }).optional(),
    })
    .optional(),
  tool_use_result: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  permission_denials: z.array(z.unknown()).optional(),
  terminal_reason: z.string().nullable().optional(),
  rate_limit_info: z
    .looseObject({
      status: z.enum(["allowed", "allowed_warning", "rejected"]),
      resetsAt: z.number().nullable().optional(),
      overageStatus: z.string().nullable().optional(),
      errorCode: z.string().nullable().optional(),
    })
    .optional(),
  task_id: z.string().optional(),
  tasks: z.array(z.object({ task_id: z.string() })).optional(),
});

export function mapSdkMessage(
  raw: unknown,
  previousTasks: ReadonlySet<string> = new Set(),
): AgentOutput[] {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return [];
  const m = parsed.data;
  const parentToolUseId = m.parent_tool_use_id ?? null;
  if (m.type === "system" && m.subtype === "init")
    return [
      {
        kind: "init",
        sessionId: m.session_id ?? "",
        commands: [...new Set([...(m.slash_commands ?? []), ...(m.skills ?? [])])].map((name) => ({
          name,
          description: "",
        })),
      },
    ];
  if (
    m.type === "stream_event" &&
    m.event?.type === "content_block_delta" &&
    m.event.delta?.type === "text_delta"
  )
    return [{ kind: "text_delta", text: m.event.delta.text ?? "", parentToolUseId }];
  if (m.type === "assistant") {
    const outputs: AgentOutput[] = m.error ? [{ kind: "assistant_error", error: m.error }] : [];
    for (const [index, block] of (m.message?.content ?? []).entries()) {
      if (block.type === "text")
        outputs.push({
          kind: "assistant_text",
          uuid: `${m.uuid}:text:${index}`,
          text: block.text ?? "",
          parentToolUseId,
        });
      if (block.type === "tool_use")
        outputs.push({
          kind: "tool_use",
          uuid: `${m.uuid}:tool:${index}`,
          toolUseId: block.id ?? "",
          name: block.name ?? "",
          input: block.input,
          parentToolUseId,
        });
    }
    return outputs;
  }
  if (m.type === "user")
    return (m.message?.content ?? []).flatMap((block, index): AgentOutput[] => {
      if (block.type !== "tool_result") return [];
      let diff: DiffOutput | null = null;
      const parsedResult = diffResultSchema.safeParse(m.tool_use_result);
      const result = parsedResult.success ? parsedResult.data : null;
      if (result && (result.structuredPatch || result.type === "create")) {
        diff = {
          path: result.filePath ?? result.file_path ?? "",
          change:
            result.type === "create" ? "create" : result.type === "update" ? "update" : "edit",
          hunks:
            result.type === "create"
              ? []
              : (result.structuredPatch ?? []).map((p) => ({
                  old_start: p.oldStart,
                  old_lines: p.oldLines,
                  new_start: p.newStart,
                  new_lines: p.newLines,
                  lines: p.lines,
                })),
          ...(result.type === "create" ? { content: result.content ?? "" } : {}),
        };
      }
      return [
        {
          kind: "tool_result",
          uuid: `${m.uuid}:result:${index}`,
          toolUseId: block.tool_use_id ?? "",
          isError: block.is_error ?? false,
          content:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
          diff,
          parentToolUseId,
        },
      ];
    });
  if (m.type === "result")
    return [
      {
        kind: "turn_end",
        subtype: m.subtype ?? "error_during_execution",
        usage: {
          inputTokens: m.usage?.input_tokens ?? 0,
          outputTokens: m.usage?.output_tokens ?? 0,
          cacheCreationInputTokens: m.usage?.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: m.usage?.cache_read_input_tokens ?? 0,
        },
        costUsd: m.total_cost_usd ?? 0,
        durationMs: m.duration_ms ?? 0,
        permissionDenials: m.permission_denials?.length ?? 0,
        terminalReason: m.terminal_reason ?? null,
      },
    ];
  if (m.type === "rate_limit_event" && m.rate_limit_info)
    return [
      {
        kind: "rate_limit",
        status: m.rate_limit_info.status,
        resetsAt: m.rate_limit_info.resetsAt ?? null,
        overageStatus: m.rate_limit_info.overageStatus ?? null,
        errorCode: m.rate_limit_info.errorCode ?? null,
        raw,
      },
    ];
  if (m.type === "system" && m.subtype === "background_tasks_changed") {
    const ids = new Set((m.tasks ?? []).map((t) => t.task_id));
    return [
      ...[...previousTasks]
        .filter((id) => !ids.has(id))
        .map((taskId) => ({ kind: "background_task" as const, taskId, running: false })),
      ...[...ids].map((taskId) => ({ kind: "background_task" as const, taskId, running: true })),
    ];
  }
  if (
    m.type === "system" &&
    m.task_id &&
    (m.subtype === "task_started" || m.subtype === "task_notification")
  )
    return [{ kind: "background_task", taskId: m.task_id, running: m.subtype === "task_started" }];
  return [];
}
