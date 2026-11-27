import { describe, expect, it } from "vite-plus/test";
import { worktreeSafety, type WorktreeSafetyInput } from "./worktree-safety";

const clean: WorktreeSafetyInput = {
  main: false,
  origin: "user",
  issue: null,
  conversations: [],
  locked: null,
  uncommittedCount: 0,
  uncommittedSample: [],
  unpushedCount: 0,
  head: "abc",
  mergedPrHeads: [],
};

describe("worktree を消す前の判定", () => {
  it.each<[Partial<WorktreeSafetyInput>, string, string, number, string[]]>([
    [
      { main: true, origin: "flow", issue: { number: 42, state: "ready" } },
      "main",
      "プロジェクトのディレクトリは消せません",
      0,
      [],
    ],
    [
      { origin: "flow", issue: { number: 42, state: "ready" }, locked: "作業中" },
      "flow",
      "issue #42 の自動フローが使っています。issue が閉じると片付けられます",
      0,
      [],
    ],
    ...["working", "waiting_answer", "waiting_permission"].map<
      [Partial<WorktreeSafetyInput>, string, string, number, string[]]
    >((runState) => [
      { conversations: [{ title: "予約 API の壁打ち", runState }], locked: "作業中" },
      "running",
      "会話: 予約 API の壁打ち の AI が動いています。止めてから消してください",
      0,
      [],
    ]),
    [
      { locked: "作業中", uncommittedCount: 3 },
      "locked",
      "この worktree はロックされています: 作業中",
      0,
      [],
    ],
    [
      {
        uncommittedCount: 3,
        uncommittedSample: ["src/a.ts", "src/b.ts", "README.md"],
        unpushedCount: 2,
      },
      "uncommitted",
      "未コミットの変更があるため消していません (src/a.ts ほか 2 件)",
      3,
      ["src/a.ts", "src/b.ts", "README.md"],
    ],
    [
      { uncommittedCount: 1, uncommittedSample: ["a.ts"] },
      "uncommitted",
      "未コミットの変更があるため消していません (a.ts)",
      1,
      ["a.ts"],
    ],
    [{ unpushedCount: 2 }, "unpushed", "未 push のコミットがあるため消していません", 2, []],
  ])("安全でない材料 %j では最初の理由を返す", (patch, reason, message, count, sample) => {
    expect(worktreeSafety({ ...clean, ...patch })).toEqual({
      allowed: false,
      unpushedCount: patch.unpushedCount ?? 0,
      conflict: { code: "conflict", message, details: { reason, count, sample } },
    });
  });
  it.each([null, { number: 42, state: "done" }, { number: 42, state: "withdrawn" }])(
    "閉じた issue %j と停止中の会話なら消せる",
    (issue) => {
      expect(
        worktreeSafety({
          ...clean,
          origin: "flow",
          issue,
          conversations: [{ title: null, runState: "stopped" }],
        }),
      ).toEqual({ allowed: true, unpushedCount: 0, conflict: null });
    },
  );
  it("issue のない worktree は PR の HEAD が一致しても未 push に数える", () => {
    expect(worktreeSafety({ ...clean, unpushedCount: 1, mergedPrHeads: ["abc"] })).toEqual({
      allowed: false,
      unpushedCount: 1,
      conflict: {
        code: "conflict",
        message: "未 push のコミットがあるため消していません",
        details: { reason: "unpushed", count: 1, sample: [] },
      },
    });
  });
  it("issue の HEAD がどれかの merge 済み PR と一致すると未 push に数えない", () => {
    expect(
      worktreeSafety({
        ...clean,
        issue: { number: 42, state: "done" },
        unpushedCount: 3,
        mergedPrHeads: ["old", "abc"],
      }),
    ).toEqual({ allowed: true, unpushedCount: 0, conflict: null });
    expect(
      worktreeSafety({
        ...clean,
        issue: { number: 42, state: "done" },
        unpushedCount: 3,
        mergedPrHeads: ["old"],
      }),
    ).toEqual({
      allowed: false,
      unpushedCount: 3,
      conflict: {
        code: "conflict",
        message: "未 push のコミットがあるため消していません",
        details: { reason: "unpushed", count: 3, sample: [] },
      },
    });
  });
});
