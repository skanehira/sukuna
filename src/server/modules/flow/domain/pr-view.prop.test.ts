import { test, fc } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { checksView, canCommentOnLine, parsePrDiff } from "./pr-view";
test.prop([
  fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 30 }),
  fc.constantFrom("FAILURE", "SUCCESS", "CANCELLED", "SKIPPED"),
])("CI の同じ結果は全検査を所定の見出しへ数える", (names, conclusion) => {
  const view = checksView(names.map((name) => ({ name, conclusion, status: "COMPLETED" })));
  const success = ["SUCCESS", "SKIPPED"].includes(conclusion);
  expect(view.counts).toEqual({
    success: success ? names.length : 0,
    failure: success ? 0 : names.length,
    running: 0,
  });
  expect(view.checks.map((c) => c.name)).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});
test.prop([
  fc.integer({ min: 1, max: 10000 }),
  fc.string({ minLength: 1 }).filter((s) => !/[\r\n]/.test(s)),
])("差分の新しい行を別コミットから引用しても同じ行なら行コメントにできる", (line, text) => {
  const files = parsePrDiff(
    `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -${line},0 +${line},1 @@\n+${text}\n`,
  );
  expect(
    canCommentOnLine(
      {
        kind: "pr_diff",
        mode: "line",
        path: "a",
        commit: "a".repeat(40),
        text,
        start: { line, col: 0, side: "new" },
        end: { line, col: 0, side: "new" },
      },
      "b".repeat(40),
      files,
    ),
  ).toBe(true);
});
test.prop([
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.boolean(),
])("StatusContext は返却順によらず startedAt が新しい再実行を表示する", (at, delta, reverse) => {
  const older = {
    __typename: "StatusContext",
    context: "deploy",
    state: "FAILURE",
    startedAt: new Date(at).toISOString(),
  };
  const newer = { ...older, state: "SUCCESS", startedAt: new Date(at + delta).toISOString() };
  expect(checksView(reverse ? [newer, older] : [older, newer])).toEqual({
    checks: [
      {
        name: "deploy",
        kind: "status_context",
        status: null,
        conclusion: null,
        state: "success",
        outcome: "success",
        startedAt: at + delta,
        completedAt: null,
        detailsUrl: null,
      },
    ],
    counts: { success: 1, failure: 0, running: 0 },
  });
});

test.prop([
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.boolean(),
  fc.constantFrom("none", "started", "completed-only"),
])("作成時刻が新しい検査を開始・完了の逆順に左右されず選ぶ", (at, delta, reverse, timing) => {
  const older = {
    __typename: "CheckRun",
    name: "test",
    status: timing === "none" ? "QUEUED" : "COMPLETED",
    conclusion: timing === "none" ? null : "SUCCESS",
    startedAt: timing === "started" ? new Date(at + delta + 200).toISOString() : null,
    completedAt: timing === "none" ? null : new Date(at + delta + 400).toISOString(),
    createdAt: new Date(at).toISOString(),
    detailsUrl: "https://example.com/older",
    runId: 900,
  };
  const newer = {
    ...older,
    conclusion: timing === "none" ? null : "FAILURE",
    startedAt: timing === "started" ? new Date(at + delta + 100).toISOString() : null,
    completedAt: timing === "none" ? null : new Date(at + delta + 300).toISOString(),
    createdAt: new Date(at + delta).toISOString(),
    detailsUrl: "https://example.com/newer",
    runId: 1,
  };
  expect(checksView(reverse ? [newer, older] : [older, newer])).toEqual({
    checks: [
      {
        name: "test",
        kind: "check_run",
        status: timing === "none" ? "queued" : "completed",
        conclusion: timing === "none" ? null : "failure",
        state: null,
        outcome: timing === "none" ? "queued" : "failure",
        startedAt: timing === "started" ? at + delta + 100 : null,
        completedAt: timing === "none" ? null : at + delta + 300,
        detailsUrl: newer.detailsUrl,
      },
    ],
    counts: { success: 0, failure: timing === "none" ? 0 : 1, running: timing === "none" ? 1 : 0 },
  });
});
test.prop([fc.integer({ min: 1, max: 1_000_000 }), fc.boolean()])(
  "日時が無い同名の候補は末尾を採用せず判定不能として返す",
  (id, reverse) => {
    const a = {
      __typename: "CheckRun",
      name: "test",
      status: "QUEUED",
      runId: id,
      detailsUrl: "https://example.com/a",
    };
    const b = { ...a, runId: id + 1, detailsUrl: "https://example.com/b" };
    expect(checksView(reverse ? [a, b] : [b, a])).toEqual({
      checks: [],
      counts: { success: 0, failure: 0, running: 0 },
      ambiguousNames: ["test"],
    });
  },
);

test.prop([
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.boolean(),
  fc.boolean(),
])("CheckRun の開始・完了順だけでは作成順を確定しない", (at, delta, reverse, completedOnly) => {
  const older = {
    __typename: "CheckRun",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: completedOnly ? null : new Date(at + delta).toISOString(),
    completedAt: new Date(at + delta + 100).toISOString(),
  };
  const newer = {
    ...older,
    conclusion: "FAILURE",
    startedAt: completedOnly ? null : new Date(at).toISOString(),
    completedAt: new Date(at + 100).toISOString(),
  };
  expect(checksView(reverse ? [newer, older] : [older, newer])).toEqual({
    checks: [],
    counts: { success: 0, failure: 0, running: 0 },
    ambiguousNames: ["test"],
  });
});

test.prop([
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.boolean(),
  fc.boolean(),
])(
  "同名の CheckRun と StatusContext もグループ全体の作成順で一件だけ数える",
  (at, delta, contextNewer, reverse) => {
    const run = {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "FAILURE",
      createdAt: new Date(contextNewer ? at : at + delta).toISOString(),
    };
    const context = {
      __typename: "StatusContext",
      context: "test",
      state: "SUCCESS",
      startedAt: new Date(contextNewer ? at + delta : at).toISOString(),
    };
    expect(checksView(reverse ? [context, run] : [run, context])).toEqual({
      checks: [
        contextNewer
          ? {
              name: "test",
              kind: "status_context",
              status: null,
              conclusion: null,
              state: "success",
              outcome: "success",
              startedAt: at + delta,
              completedAt: null,
              detailsUrl: null,
            }
          : {
              name: "test",
              kind: "check_run",
              status: "completed",
              conclusion: "failure",
              state: null,
              outcome: "failure",
              startedAt: null,
              completedAt: null,
              detailsUrl: null,
            },
      ],
      counts: { success: contextNewer ? 1 : 0, failure: contextNewer ? 0 : 1, running: 0 },
    });
  },
);
