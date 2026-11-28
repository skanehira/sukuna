import { useCallback, useState, useSyncExternalStore } from "react";
import {
  formatOutputTokens,
  formatStageElapsed,
  formatTurnElapsed,
} from "../../shared/activity/stage";

export type WorkingStatus = {
  action: "考え中" | "ツールを実行中";
  turnStartedAt: number | null;
  outputTokens: number | null;
  stage: { label: string; startedAt: number } | null;
};
export type MotionPreference = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => boolean;
};
type Schedule = (fn: () => void, ms: number) => () => void;

const marks = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const stillMark = "✻";

export const fullMotion: MotionPreference = { subscribe: () => () => {}, snapshot: () => false };

export function reducedMotionPreference(media: Pick<Window, "matchMedia">): MotionPreference {
  const query = media.matchMedia("(prefers-reduced-motion: reduce)");
  return {
    subscribe: (listener) => {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    snapshot: () => query.matches,
  };
}

class Ticks {
  count = 0;
  snapshot = () => this.count;
}

function useTicks(schedule: Schedule, ms: number, running: boolean): number {
  const [ticks] = useState(() => new Ticks());
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!running) return () => {};
      let cancel = schedule(function tick() {
        ticks.count++;
        listener();
        cancel = schedule(tick, ms);
      }, ms);
      return () => cancel();
    },
    [schedule, ms, running, ticks],
  );
  return useSyncExternalStore(subscribe, ticks.snapshot);
}

function workingText(status: WorkingStatus, now: () => number): string {
  const details = [
    status.turnStartedAt === null ? null : formatTurnElapsed(status.turnStartedAt, { now }),
    status.outputTokens ? `↓ ${formatOutputTokens(status.outputTokens)} トークン` : null,
  ].filter((detail) => detail !== null);
  const stage = status.stage
    ? ` / ${status.stage.label} ${formatStageElapsed(status.stage.startedAt, { now })}`
    : "";
  return `${status.action}…${details.length ? ` (${details.join(" · ")})` : ""}${stage}`;
}

export function WorkingLine({
  status,
  still,
  now,
  schedule,
}: {
  status: WorkingStatus;
  still: boolean;
  now: () => number;
  schedule: Schedule;
}) {
  const frame = useTicks(schedule, 120, !still);
  useTicks(schedule, 1000, true);
  return (
    <>
      <span aria-hidden="true" className="inline-block w-[1em] text-center">
        {still ? stillMark : marks[frame % marks.length]}
      </span>{" "}
      {workingText(status, now)}
    </>
  );
}
