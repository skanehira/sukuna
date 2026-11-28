import { describe, expect, it } from "vite-plus/test";
import { implementationQueue, type ImplementationCandidate } from "./impl-queue";

function issue(
  number: number,
  changes: Partial<ImplementationCandidate> = {},
): ImplementationCandidate {
  return {
    id: String(number),
    number,
    state: "ready",
    priority: null,
    parentId: null,
    dependsOn: [],
    stoppedFrom: null,
    busy: false,
    ...changes,
  };
}

describe("実装待ちの選び方", () => {
  it("子、開いた依存先、承認前の親、稼働中の段階を待つ", () => {
    const rows = [
      issue(1),
      issue(2, { parentId: "1" }),
      issue(3, { state: "design" }),
      issue(4, { parentId: "3" }),
      issue(5, { state: "stopped", stoppedFrom: "design_review" }),
      issue(6, { parentId: "5" }),
      issue(7, { dependsOn: ["3"] }),
      issue(8, { busy: true }),
      issue(9, { state: "done" }),
      issue(10, { dependsOn: ["9"] }),
    ];
    expect(implementationQueue(rows, true, 9)).toEqual({
      start: ["2", "10"],
      withdrawn: [],
    });
  });

  it("取り下げを停止へ回し、閉じていない間接依存元から優先度を引き継ぐ", () => {
    const rows = [
      issue(1, { priority: "low" }),
      issue(2),
      issue(3, { dependsOn: ["1"], priority: "low" }),
      issue(4, { dependsOn: ["3"], priority: "high" }),
      issue(5, { state: "withdrawn" }),
      issue(6, { dependsOn: ["5"] }),
      issue(7, { priority: "low" }),
      issue(8, { state: "done", dependsOn: ["7"], priority: "high" }),
      issue(9),
    ];
    expect(implementationQueue(rows, true, 3)).toEqual({
      start: ["1", "2", "9"],
      withdrawn: ["6"],
    });
  });

  it("停止中は枠に数えず、一時停止や段階の除外では始めない", () => {
    const rows = [
      issue(1, { state: "implementing" }),
      issue(2, { state: "stopped", stoppedFrom: "implementing" }),
      issue(3),
    ];
    expect(implementationQueue(rows, true, 1).start).toEqual([]);
    expect(implementationQueue(rows, true, 2).start).toEqual(["3"]);
    expect(implementationQueue(rows, false, 2).start).toEqual([]);
  });
});
