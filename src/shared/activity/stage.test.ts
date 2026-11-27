import { describe, expect, it } from "vitest";
import { formatStageElapsed, resolveStage, type ActivityEvent } from "./stage";

describe("作業の工程", () => {
  it.each<[string | null, readonly ActivityEvent[], string, string, number]>([
    [null, [], "reply", "応答", 100],
    [
      "triage",
      [{ type: "state_changed", payload: { to: "triage" }, createdAt: 200 }],
      "triage",
      "精査",
      200,
    ],
    [
      "design",
      [{ type: "state_changed", payload: { to: "design" }, createdAt: 300 }],
      "design",
      "設計",
      300,
    ],
    [
      "implementing",
      [{ type: "state_changed", payload: { to: "implementing" }, createdAt: 400 }],
      "implement",
      "実装",
      400,
    ],
    ...(
      [
        ["implement", "実装"],
        ["review", "レビュー"],
        ["pr", "PR"],
        ["ci", "CI 待ち"],
        ["merge", "merge"],
      ] as const
    ).map(([stage, label]): [string, ActivityEvent[], string, string, number] => [
      "implementing",
      [
        { type: "state_changed", payload: { to: "implementing" }, createdAt: 400 },
        { type: "stage_changed", payload: { stage }, createdAt: 500 },
      ],
      stage,
      label,
      500,
    ]),
  ])("%s の工程と始まりを求める", (issueState, events, stage, stageLabel, stageStartedAt) => {
    expect(resolveStage({ issueState, events, turnStartedAt: 100 })).toEqual({
      stage,
      stageLabel,
      stageStartedAt,
    });
  });

  it("再実装の開始が古い段階より新しければ開始時刻を使う", () => {
    expect(
      resolveStage({
        issueState: "implementing",
        turnStartedAt: 100,
        events: [
          { type: "stage_changed", payload: { stage: "implement" }, createdAt: 200 },
          { type: "state_changed", payload: { to: "implementing" }, createdAt: 600 },
        ],
      }),
    ).toEqual({ stage: "implement", stageLabel: "実装", stageStartedAt: 600 });
  });

  it.each([
    [59000, "1分未満"],
    [60000, "1分"],
    [3599999, "59分"],
    [3600000, "1時間0分"],
    [3660000, "1時間1分"],
  ])("経過 %i ms を境界に従って表す", (now, expected) => {
    expect(formatStageElapsed(0, { now: () => now })).toBe(expected);
  });
});
