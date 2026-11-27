import type Database from "better-sqlite3";
import type { RunState, StopReason } from "../events";

const liveStopStates = [
  "working",
  "waiting_answer",
  "waiting_permission",
  "usage_limited",
] satisfies RunState[];

export function isProjectStopTarget({
  runState,
  stopReason,
}: {
  runState: RunState;
  stopReason: StopReason | null;
}): boolean {
  return (
    liveStopStates.some((state) => state === runState) ||
    (runState === "stopped" && stopReason === "restarted")
  );
}

export function projectStopTargets(sqlite: Database.Database, projectId: string): string[] {
  return (
    sqlite
      .prepare(
        `SELECT id
      FROM conversations WHERE project_id = ?
      AND (run_state IN (${liveStopStates.map(() => "?").join(", ")}) OR
        (run_state = 'stopped' AND stop_reason = 'restarted'))
      ORDER BY id`,
      )
      .all(projectId, ...liveStopStates) as { id: string }[]
  ).map(({ id }) => id);
}
