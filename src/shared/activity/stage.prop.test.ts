import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { formatOutputTokens, formatStageElapsed, formatTurnElapsed, resolveStage } from "./stage";

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
test.prop([
  fc.integer({ min: 0, max: 3599 }),
  fc.integer({ min: 0, max: 999 }),
  fc.integer({ min: 0, max: 100000 }),
])("1 時間未満の番の経過は、書いた文を分と秒に読み戻すと元の秒数になる", (n, remainder, start) => {
  const text = formatTurnElapsed(start, { now: () => start + n * 1000 + remainder });
  const [, minutes, seconds] = /^(?:(\d+)分)?(\d+)秒$/.exec(text) ?? [];
  expect(Number(minutes ?? 0) * 60 + Number(seconds)).toBe(n);
});
test.prop([fc.integer({ min: 0, max: 999_999_999 })])(
  "出力トークンの数の書いた文を読み戻すと、元の数を小数 1 桁で切り捨てた値になる",
  (tokens) => {
    const [, value, suffix] = /^(\d+(?:\.\d)?)([kM]?)$/.exec(formatOutputTokens(tokens)) ?? [];
    const unit = suffix === "M" ? 1_000_000 : suffix === "k" ? 1000 : 1;
    const tenths = suffix ? Number(value?.replace(".", "")) : Number(value) * 10;
    expect(tenths).toBe(Math.floor((tokens * 10) / unit));
    expect(unit).toBe(tokens < 1000 ? 1 : tokens < 1_000_000 ? 1000 : 1_000_000);
  },
);
