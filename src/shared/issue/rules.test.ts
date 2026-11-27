import { describe, expect, it } from "vite-plus/test";
import { validateIssueLinks, validateIssueInput } from "./rules";

describe("issue の保存規則", () => {
  it.each([
    [[1, 1]],
    [
      [1, 2],
      [2, 1],
    ],
    [
      [1, 2],
      [2, 3],
      [3, 1],
    ],
  ])("循環 %j は番号の並びを返す", (...edges: number[][]) => {
    const graph = edges.map(([number, next]) => ({
      number: number!,
      parentNumber: null,
      dependsOn: [next!],
    }));
    const path = [...edges.map(([number]) => `#${number}`), "#1"].join(" → ");
    expect(validateIssueLinks(graph, 1, null, graph[0]!.dependsOn)).toEqual({
      code: "dependency_cycle",
      message: `${path} が循環しています。依存を保存しませんでした`,
    });
  });
  it.each([
    [[1, 1]],
    [
      [1, 2],
      [2, 1],
    ],
    [
      [1, 2],
      [2, 3],
      [3, 1],
    ],
  ])("親の循環 %j は番号の並びを返す", (...edges: number[][]) => {
    const graph = edges.map(([number, next]) => ({
      number: number!,
      parentNumber: next!,
      dependsOn: [],
    }));
    const path = [...edges.map(([number]) => `#${number}`), "#1"].join(" → ");
    expect(validateIssueLinks(graph, 1, graph[0]!.parentNumber, [])).toEqual({
      code: "parent_cycle",
      message: `${path} が循環しています。親を保存しませんでした`,
    });
  });
  it("親と依存は別々にたどり、混ざったつながりを循環としない", () => {
    const graph = [
      { number: 1, parentNumber: null, dependsOn: [2] },
      { number: 2, parentNumber: 1, dependsOn: [] },
    ];
    expect(validateIssueLinks(graph, 1, null, [2])).toBeNull();
    expect(validateIssueLinks(graph, 1, 2, [2])).toEqual({
      code: "parent_cycle",
      message: "#1 → #2 → #1 が循環しています。親を保存しませんでした",
    });
    expect(validateIssueLinks(graph, 1, null, [99])).toEqual({
      code: "invalid_input",
      message: "#99 はこのプロジェクトにありません",
    });
  });
  it("長さと件数の上限ちょうどは通し、超えた入力を断る", () => {
    const maximum = {
      title: "あ".repeat(200),
      body: "本".repeat(50000),
      dependsOn: Array.from({ length: 50 }, (_, i) => i + 1),
    };
    expect(validateIssueInput(maximum)).toEqual(maximum);
    for (const input of [
      { ...maximum, title: "あ".repeat(201) },
      { ...maximum, body: "本".repeat(50001) },
      { ...maximum, dependsOn: [...maximum.dependsOn, 51] },
      { title: "a\nb" },
      { title: "\na" },
      { title: "a\r" },
    ]) {
      expect(validateIssueInput(input)).toBeNull();
    }
    expect(validateIssueInput({ title: "  題名  ", body: " \n本文\n " })).toEqual({
      title: "題名",
      body: "本文",
    });
  });
  it("枝が合流しても循環とせず、別の枝の循環にはその輪だけを示す", () => {
    const graph = [
      { number: 1, parentNumber: null, dependsOn: [2, 3] },
      { number: 2, parentNumber: null, dependsOn: [4] },
      { number: 3, parentNumber: null, dependsOn: [4] },
      { number: 4, parentNumber: null, dependsOn: [] },
    ];
    expect(validateIssueLinks(graph, 1, null, [2, 3])).toBeNull();
    const cycle = [
      { number: 1, parentNumber: null, dependsOn: [2, 3] },
      { number: 2, parentNumber: null, dependsOn: [] },
      { number: 3, parentNumber: null, dependsOn: [4, 5] },
      { number: 4, parentNumber: null, dependsOn: [] },
      { number: 5, parentNumber: null, dependsOn: [3] },
    ];
    expect(validateIssueLinks(cycle, 1, null, [2, 3])).toEqual({
      code: "dependency_cycle",
      message: "#3 → #5 → #3 が循環しています。依存を保存しませんでした",
    });
    expect(validateIssueLinks(graph, 1, 99, [])).toEqual({
      code: "invalid_input",
      message: "#99 はこのプロジェクトにありません",
    });
  });
});
