import { expect, it } from "vite-plus/test";
import { evaluate, startingPoint, type Evaluation } from "./evaluate";
import { triagePriority } from "./priority";

const ready: Evaluation = {
  stage: "triage",
  pendingPr: false,
  started: false,
  projectActive: true,
  paused: false,
  stageEnabled: true,
  busy: false,
  hasWithdrawnDependencies: false,
};

it.each([
  [{}, "start"],
  [{ stage: null }, "wait"],
  [{ stage: "design", pendingPr: true }, "pr"],
  [{ started: true }, "wait"],
  [{ projectActive: false }, "wait"],
  [{ paused: true }, "wait"],
  [{ stageEnabled: false }, "wait"],
  [{ busy: true }, "wait"],
  [{ hasWithdrawnDependencies: true }, "dependency_withdrawn"],
] satisfies [Partial<Evaluation>, string][])("評価の条件 %j", (change, expected) => {
  expect(evaluate({ ...ready, ...change })).toBe(expected);
});

it("停止中から戻る前の段階の起点を使う", () => {
  const start = {
    seq: 1,
    createdAt: 100,
    type: "state_changed",
    payload: {
      from: "draft",
      to: "triage",
      cause: "confirm",
      stopReason: null,
      detail: null,
    },
  };
  expect(
    startingPoint(
      [
        start,
        {
          seq: 2,
          createdAt: 110,
          type: "state_changed",
          payload: {
            from: "triage",
            to: "triage",
            cause: "agent_resumed",
            stopReason: null,
            detail: null,
          },
        },
      ],
      "triage",
    ),
  ).toEqual(start);
});

it.each([
  [true, "low", 0, "high"],
  [false, "low", 10, "low"],
  [false, null, 9, "high"],
  [false, null, 8.9, "medium"],
  [false, null, 3, "medium"],
  [false, null, 2.9, "low"],
  [false, null, undefined, "medium"],
] as const)("優先度 %s %s %s", (urgent, parent, score, expected) => {
  expect(triagePriority(urgent, parent, score)).toBe(expected);
});
