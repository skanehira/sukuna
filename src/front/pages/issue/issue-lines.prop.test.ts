import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import "../../../test/fast-check";
import { issueFieldInput } from "./issue-form-lines";
import { issueHeadLines } from "./issue-head-lines";
import { issueView } from "./issue.test-support";

test.prop([fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 50 })])(
  "番号のある依存の入力を、相手の番号と順を保って保存する",
  (numbers) => {
    const text = numbers
      .map((number, index) => (index % 2 ? `#${number}` : String(number)))
      .join("、");
    expect(issueFieldInput("dependsOn", text)).toEqual({ dependsOn: numbers });
  },
);

test.prop([
  fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 20 }),
])("子を入れた順に関係なく、番号順に並び、最初の行だけ子と書く", (numbers) => {
  const issue = issueView({
    children: numbers.map((number) => ({
      id: `child-${number}`,
      number,
      title: `子 ${number}`,
      state: "ready",
    })),
  });
  const childRows = issueHeadLines(issue, undefined).filter((line) =>
    line.id?.startsWith("child:"),
  );
  expect(childRows.map((line) => line.target?.url)).toEqual(
    numbers.toSorted((left, right) => left - right).map((number) => `/issues/child-${number}`),
  );
  expect(childRows.map((line) => line.cols?.[0])).toEqual(
    Array.from({ length: numbers.length }, (_, index) => (index === 0 ? "子" : "")),
  );
});
