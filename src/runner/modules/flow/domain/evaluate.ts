import { stateChangedSchema } from "../../../../shared/issue/state";

export type Stage = "triage" | "design";
export type FlowEvent = { seq: number; createdAt: number; type: string; payload: unknown };
export type Evaluation = {
  stage: Stage | null;
  pendingPr: boolean;
  started: boolean;
  projectActive: boolean;
  paused: boolean;
  stageEnabled: boolean;
  busy: boolean;
  hasWithdrawnDependencies: boolean;
};

export function evaluate(input: Evaluation) {
  if (
    !input.stage ||
    input.started ||
    !input.projectActive ||
    input.paused ||
    !input.stageEnabled ||
    input.busy
  )
    return "wait";
  if (input.hasWithdrawnDependencies) return "dependency_withdrawn";
  return input.pendingPr ? "pr" : "start";
}

export function stateChange(event: FlowEvent | undefined) {
  if (event?.type !== "state_changed") return;
  const result = stateChangedSchema.safeParse(event.payload);
  return result.success ? result.data : undefined;
}

export function startingPoint(events: FlowEvent[], stage: Stage) {
  return events.findLast((event) => {
    const change = stateChange(event);
    return (
      change?.to === stage &&
      change.from !== "stopped" &&
      !["agent_resumed", "dependency_cleared"].includes(change.cause)
    );
  });
}

export function flowStage(kind: string): Stage | null {
  return kind === "triage" || kind === "design" ? kind : null;
}

export function hasFlowHistory(events: FlowEvent[]) {
  return events.some(
    (event) =>
      event.type === "created" ||
      event.type === "ai_started" ||
      ["confirm", "ai_created"].includes(stateChange(event)?.cause ?? ""),
  );
}
