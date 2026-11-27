import type { AgentOutput } from "./agent-port";
import type { RunState, ConversationEvent } from "../../../../shared/events";
export type RateLimit = Extract<AgentOutput, { kind: "rate_limit" }>;
export type StopIntent = "user" | "interrupt" | "dependency_withdrawn";
export type StoppedPayload = Extract<ConversationEvent, { type: "stopped" }>["payload"];
export function classifyStop(
  end: { subtype: string; terminalReason: string | null },
  rate: RateLimit | null,
  assistantError: string | null,
  intent: StopIntent | null,
): { state: RunState; stopped: StoppedPayload | null } {
  if (intent === "dependency_withdrawn")
    return { state: "stopped", stopped: { reason: "user", flow_trigger: intent } };
  if (intent === "user") return { state: "stopped", stopped: { reason: "user" } };
  if (intent === "interrupt") return { state: "working", stopped: null };
  if (
    rate?.status === "rejected" &&
    rate.overageStatus !== "allowed" &&
    rate.overageStatus !== "allowed_warning"
  ) {
    if (rate.errorCode === "credits_required")
      return { state: "failed", stopped: { reason: "credits_required" } };
    return {
      state: "usage_limited",
      stopped: {
        reason: "usage_limit",
        ...(rate.resetsAt === null ? {} : { resets_at: rate.resetsAt * 1000 }),
      },
    };
  }
  if (
    end.terminalReason === "api_error" ||
    (assistantError !== null && assistantError !== "rate_limit")
  )
    return { state: "failed", stopped: { reason: "api_error" } };
  if (end.subtype.startsWith("error_")) return { state: "failed", stopped: { reason: "error" } };
  return { state: "idle", stopped: null };
}
