import { describe, expect, it } from "vitest";
import {
  formatOutputTokens,
  formatStageElapsed,
  formatTurnElapsed,
  resolveStage,
  type ActivityEvent,
} from "./stage";

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

it("状態変更と段階変更は対応する種類と状態の記録だけを採用する", () => {
  expect(
    resolveStage({
      issueState: "design",
      turnStartedAt: 1,
      events: [
        { type: "state_changed", payload: { to: "design" }, createdAt: 10 },
        { type: "assistant_text", payload: { to: "design" }, createdAt: 20 },
        { type: "state_changed", payload: { to: "ready" }, createdAt: 30 },
      ],
    }),
  ).toEqual({ stage: "design", stageLabel: "設計", stageStartedAt: 10 });
  expect(
    resolveStage({
      issueState: "implementing",
      turnStartedAt: 1,
      events: [
        { type: "stage_changed", payload: { stage: "review" }, createdAt: 10 },
        { type: "assistant_text", payload: { stage: "merge" }, createdAt: 20 },
        { type: "stage_changed", payload: null, createdAt: 30 },
      ],
    }),
  ).toEqual({ stage: "review", stageLabel: "レビュー", stageStartedAt: 10 });
});

it.each([
  [-1, "0秒"],
  [59_999, "59秒"],
  [60_000, "1分0秒"],
  [3_599_999, "59分59秒"],
  [3_600_000, "1時間0分"],
])("番の経過 %i ms を境界に従って秒まで表す", (now, expected) => {
  expect(formatTurnElapsed(0, { now: () => now })).toBe(expected);
});

it.each([
  [999, "999"],
  [1000, "1.0k"],
  [2149, "2.1k"],
  [999_999, "999.9k"],
  [1_000_000, "1.0M"],
])("出力トークンの数 %i を %s と書く", (tokens, expected) => {
  expect(formatOutputTokens(tokens)).toBe(expected);
});
