import type { ConversationRuntime } from "./runtime";
export function recover(runtime: ConversationRuntime): void {
  for (const c of runtime.store.list()) {
    if (["working", "waiting_answer", "waiting_permission"].includes(c.runState))
      runtime.record(c.id, [
        { type: "stopped", payload: { reason: "restarted", previous_run_state: c.runState } },
      ]);
    if (c.runState === "usage_limited") runtime.scheduleUsageResume(c.id);
  }
}
