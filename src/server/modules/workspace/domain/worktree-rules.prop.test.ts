import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { defaultWorktreeName, validWorktreeName } from "./worktree-rules";

const alphanumeric = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
);
const suffix = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-".split("")), {
  maxLength: 55,
});

test.prop([alphanumeric, suffix])(
  "許された文字で作った名前は使え、予約名や禁則を付けると使えない",
  (first, rest) => {
    const name = `T${first}${rest.join("")}0`;
    expect([
      validWorktreeName(name),
      validWorktreeName(`${name}.lock`),
      validWorktreeName(`issue-${name}`),
      validWorktreeName(`design-${name}`),
      validWorktreeName(`.${name}`),
      validWorktreeName(`${name}/child`),
    ]).toEqual([true, false, false, false, false, false]);
  },
);

test.prop([
  fc.integer({ min: 2, max: 100 }),
  fc.array(fc.boolean(), { minLength: 100, maxLength: 100 }),
])("省略名は worktree とブランチの両方を避け、空いている最小の連番を使う", (gap, inWorktree) => {
  const date = new Date(2026, 10, 27, 9, 5);
  const base = "chat-20261127-0905";
  const worktrees = [base, `${base}-${gap + 1}`];
  const branches: string[] = [];
  for (let number = 2; number < gap; number += 1)
    (inWorktree[number] ? worktrees : branches).push(`${base}-${number}`);
  expect(defaultWorktreeName(date, worktrees, branches)).toBe(`${base}-${gap}`);
});
