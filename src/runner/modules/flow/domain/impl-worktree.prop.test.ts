import { fc, test } from "@fast-check/vitest";
import { implementationWorktreeName, nextPortSlot } from "./impl-worktree";

test.prop([fc.array(fc.nat({ max: 40 }))])("0 から始まる空き枠の最小値を選ぶ", (slots) => {
  const result = nextPortSlot(slots);
  return (
    !slots.includes(result) &&
    Array.from({ length: result }, (_, slot) => slot).every((slot) => slots.includes(slot))
  );
});

test.prop([fc.integer({ min: 1, max: 10000 }), fc.nat({ max: 20 })])(
  "worktree またはブランチが連続して使用中なら最初の空き番号に揃える",
  (number, occupied) => {
    const names = Array.from({ length: occupied }, (_, index) =>
      index === 0 ? `issue-${number}` : `issue-${number}-${index + 1}`,
    );
    const result = implementationWorktreeName(
      number,
      names.filter((_, index) => index % 2 === 0),
      names.filter((_, index) => index % 2 === 1).map((name) => `sukuna/${name}`),
    );
    const next = occupied === 0 ? `issue-${number}` : `issue-${number}-${occupied + 1}`;
    return result.name === next && result.branch === `sukuna/${next}`;
  },
);
