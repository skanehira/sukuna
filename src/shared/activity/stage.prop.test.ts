import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { formatStageElapsed, resolveStage } from "./stage";

const stages = [
  { stage: "implement", stageLabel: "実装" },
  { stage: "review", stageLabel: "レビュー" },
  { stage: "pr", stageLabel: "PR" },
  { stage: "ci", stageLabel: "CI 待ち" },
  { stage: "merge", stageLabel: "merge" },
] as const;
test.prop([
  fc.constantFrom(...stages),
  fc.integer({ min: 1, max: 100000 }),
  fc.integer({ min: 1, max: 100000 }),
])("最後の実装段階と新しいほうの開始時刻を返す", (stage, entered, recorded) => {
  expect(
    resolveStage({
      issueState: "implementing",
      turnStartedAt: 0,
      events: [
        { type: "state_changed", payload: { to: "implementing" }, createdAt: entered },
        { type: "stage_changed", payload: { stage: "design" }, createdAt: 200000 },
        { type: "stage_changed", payload: { stage: stage.stage }, createdAt: recorded },
      ],
    }),
  ).toEqual({ ...stage, stageStartedAt: Math.max(entered, recorded) });
});
test.prop([
  fc.integer({ min: 0, max: 2880 }),
  fc.integer({ min: 0, max: 59999 }),
  fc.integer({ min: 0, max: 100000 }),
])("経過時間を分未満・分・時間と分へ変換する", (minutes, remainder, start) => {
  expect(formatStageElapsed(start, { now: () => start + minutes * 60000 + remainder })).toBe(
    minutes === 0
      ? "1分未満"
      : minutes < 60
        ? `${minutes}分`
        : `${Math.floor(minutes / 60)}時間${minutes % 60}分`,
  );
});
