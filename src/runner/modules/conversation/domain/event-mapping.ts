import type { ConversationEvent } from "../../../../shared/events";
import type { AgentOutput } from "./agent-port";
function cut(text: string, limit: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= limit) return text;
  let end = limit;
  while ((encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end));
}
function cutInput(value: unknown): unknown {
  if (typeof value === "string") return cut(value, 16 * 1024);
  if (Array.isArray(value)) return value.map(cutInput);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutInput(v)]));
  return value;
}
export function outputEvents(output: AgentOutput): ConversationEvent[] {
  switch (output.kind) {
    case "assistant_text":
      return [
        {
          type: "assistant_text",
          sdkUuid: output.uuid,
          payload: { text: output.text, parent_tool_use_id: output.parentToolUseId },
        },
      ];
    case "tool_use":
      return [
        {
          type: "tool_use",
          sdkUuid: output.uuid,
          payload: {
            tool_use_id: output.toolUseId,
            name: output.name,
            input: cutInput(output.input),
            parent_tool_use_id: output.parentToolUseId,
          },
        },
      ];
    case "tool_result": {
      const bytes = new TextEncoder().encode(output.content).length;
      const result: ConversationEvent[] = [
        {
          type: "tool_result",
          sdkUuid: output.uuid,
          payload: {
            tool_use_id: output.toolUseId,
            is_error: output.isError,
            content: cut(output.content, 65536),
            bytes,
            truncated: bytes > 65536,
          },
        },
      ];
      if (output.diff) {
        let remaining = 5000;
        let truncated = false;
        const hunks = output.diff.hunks.flatMap((hunk) => {
          const lines = hunk.lines.slice(0, remaining);
          remaining -= lines.length;
          if (lines.length < hunk.lines.length) truncated = true;
          return lines.length ? [{ ...hunk, lines }] : [];
        });
        let content = output.diff.content;
        if (content !== undefined) {
          const lines = content.split("\n");
          if (lines.length > 5000) truncated = true;
          content = lines.slice(0, 5000).join("\n");
        }
        result.push({
          type: "diff",
          sdkUuid: `${output.uuid}:diff`,
          payload: {
            tool_use_id: output.toolUseId,
            path: output.diff.path,
            change: output.diff.change,
            hunks,
            ...(content === undefined ? {} : { content }),
            truncated,
          },
        });
      }
      return result;
    }
    case "turn_end":
      return [
        {
          type: "turn_end",
          payload: {
            subtype: output.subtype,
            usage: {
              input_tokens: output.usage.inputTokens,
              output_tokens: output.usage.outputTokens,
              cache_creation_input_tokens: output.usage.cacheCreationInputTokens,
              cache_read_input_tokens: output.usage.cacheReadInputTokens,
            },
            cost_usd: output.costUsd,
            duration_ms: output.durationMs,
            permission_denials: output.permissionDenials,
            ...(output.terminalReason === null ? {} : { terminal_reason: output.terminalReason }),
          },
        },
      ];
    default:
      return [];
  }
}
