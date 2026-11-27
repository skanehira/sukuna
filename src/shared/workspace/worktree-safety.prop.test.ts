import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { worktreeSafety, type WorktreeSafetyInput } from "./worktree-safety";

const safe: WorktreeSafetyInput = {
  main: false,
  origin: "flow",
  issue: { number: 42, state: "done" },
  conversations: [],
  locked: null,
  uncommittedCount: 0,
  uncommittedSample: [],
  unpushedCount: 0,
  head: "current",
  mergedPrHeads: [],
};

test.prop([
  fc.constantFrom("done", "withdrawn"),
  fc.array(fc.constantFrom("idle", "stopped", "failed", "usage_limited")),
  fc.integer({ min: 1, max: 100000 }),
  fc.array(fc.string()),
])(
  "停止した会話と閉じた issue では merge 済みの HEAD を未 push に数えず削除を許可する",
  (state, runs, count, heads) => {
    expect(
      worktreeSafety({
        ...safe,
        issue: { number: 42, state },
        conversations: runs.map((runState) => ({ title: null, runState })),
        unpushedCount: count,
        mergedPrHeads: [...heads, "current"],
      }),
    ).toEqual({ allowed: true, unpushedCount: 0, conflict: null });
  },
);

test.prop([
  fc.integer({ min: 1, max: 100000 }),
  fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
])(
  "merge 済みの HEAD でも未コミットの変更があれば件数とサンプルを返して拒否する",
  (extra, sample) => {
    const count = sample.length + extra;
    expect(
      worktreeSafety({
        ...safe,
        uncommittedCount: count,
        uncommittedSample: sample,
        unpushedCount: extra,
        mergedPrHeads: ["current"],
      }),
    ).toEqual({
      allowed: false,
      unpushedCount: 0,
      conflict: {
        code: "conflict",
        message: `未コミットの変更があるため消していません (${sample[0]} ほか ${count - 1} 件)`,
        details: { reason: "uncommitted", count, sample },
      },
    });
  },
);
