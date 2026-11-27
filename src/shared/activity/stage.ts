export const STAGE_LABELS = {
  reply: "応答",
  triage: "精査",
  design: "設計",
  implement: "実装",
  review: "レビュー",
  pr: "PR",
  ci: "CI 待ち",
  merge: "merge",
} as const;
export type Stage = keyof typeof STAGE_LABELS;
export type ActivityEvent = { type: string; payload: unknown; createdAt: number };

export function resolveStage(input: {
  issueState: string | null;
  events: readonly ActivityEvent[];
  turnStartedAt: number;
}): { stage: Stage; stageLabel: string; stageStartedAt: number } {
  const { issueState, events, turnStartedAt } = input;
  const changes = events.filter((event) => event.type === "state_changed");
  const entered = changes.findLast((event) => objectOf(event.payload).to === issueState);
  const enteredAt = entered?.createdAt ?? turnStartedAt;
  let stage: Stage = "reply";
  let stageStartedAt = turnStartedAt;
  if (issueState === "triage" || issueState === "design") {
    stage = issueState;
    stageStartedAt = enteredAt;
  } else if (issueState === "implementing") {
    const last = events.findLast(
      (event) =>
        event.type === "stage_changed" && isImplementationStage(objectOf(event.payload).stage),
    );
    const value = objectOf(last?.payload).stage;
    stage = isImplementationStage(value) ? value : "implement";
    stageStartedAt = Math.max(enteredAt, last?.createdAt ?? 0);
  }
  return { stage, stageLabel: STAGE_LABELS[stage], stageStartedAt };
}

function isImplementationStage(
  value: unknown,
): value is "implement" | "review" | "pr" | "ci" | "merge" {
  return (
    value === "implement" ||
    value === "review" ||
    value === "pr" ||
    value === "ci" ||
    value === "merge"
  );
}

export function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function formatStageElapsed(startedAt: number, clock: { now(): number }): string {
  const minutes = Math.max(0, Math.floor((clock.now() - startedAt) / 60000));
  if (minutes === 0) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
