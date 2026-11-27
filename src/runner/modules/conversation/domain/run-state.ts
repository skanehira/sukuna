import type { ConversationEvent, RunState } from "../../../../shared/events";
export function nextRunState(state: RunState, event: ConversationEvent): RunState {
  switch (event.type) {
    case "answer":
      return event.payload.as_message ? state : "working";
    case "user_message":
    case "permission_decision":
    case "resumed":
      return "working";
    case "question":
      return "waiting_answer";
    case "permission_request":
      return "waiting_permission";
    case "turn_end":
      return event.payload.subtype === "success" ? "idle" : state;
    case "stopped":
      return event.payload.reason === "usage_limit"
        ? "usage_limited"
        : ["user", "restarted"].includes(event.payload.reason)
          ? "stopped"
          : "failed";
    default:
      return state;
  }
}
