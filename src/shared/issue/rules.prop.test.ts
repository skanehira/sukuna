import { test, fc } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { validateIssueLinks, validateIssueInput } from "./rules";

test.prop([fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 30 })])(
  "依存の輪は、任意の番号の並びでも完全な循環を知らせる",
  (numbers) => {
    const graph = numbers.map((number, i) => ({
      number,
      parentNumber: null,
      dependsOn: [numbers[(i + 1) % numbers.length]!],
    }));
    expect(validateIssueLinks(graph, numbers[0]!, null, graph[0]!.dependsOn)).toEqual({
      code: "dependency_cycle",
      message: `${[...numbers, numbers[0]!].map((number) => `#${number}`).join(" → ")} が循環しています。依存を保存しませんでした`,
    });
  },
);

test.prop([fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 30 })])(
  "親の輪も、任意の番号の並びで完全な循環を知らせる",
  (numbers) => {
    const graph = numbers.map((number, i) => ({
      number,
      parentNumber: numbers[(i + 1) % numbers.length]!,
      dependsOn: [],
    }));
    expect(validateIssueLinks(graph, numbers[0]!, graph[0]!.parentNumber, [])).toEqual({
      code: "parent_cycle",
      message: `${[...numbers, numbers[0]!].map((number) => `#${number}`).join(" → ")} が循環しています。親を保存しませんでした`,
    });
  },
);
test.prop([fc.array(fc.constantFrom("在", "庫", "本", "文"), { minLength: 1, maxLength: 190 })])(
  "保存する題名と本文から前後の空白だけを取り除く",
  (characters) => {
    const text = characters.join("");
    expect(validateIssueInput({ title: `  ${text}  `, body: ` \n${text}\n ` })).toEqual({
      title: text,
      body: text,
    });
  },
);
