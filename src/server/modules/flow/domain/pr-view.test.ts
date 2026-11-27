import { describe, expect, it } from "vite-plus/test";
import { checksView, evidenceSection, canCommentOnLine, parsePrDiff } from "./pr-view";
const sha = "a".repeat(40);
describe("PR の表示の材料", () => {
  it.each([
    ["SUCCESS", "COMPLETED", "success", "success"],
    ["NEUTRAL", "COMPLETED", "skipped", "success"],
    ["SKIPPED", "COMPLETED", "skipped", "success"],
    ["FAILURE", "COMPLETED", "failure", "failure"],
    ["TIMED_OUT", "COMPLETED", "failure", "failure"],
    ["ACTION_REQUIRED", "COMPLETED", "failure", "failure"],
    ["STARTUP_FAILURE", "COMPLETED", "failure", "failure"],
    ["CANCELLED", "COMPLETED", "cancelled", "failure"],
    [null, "IN_PROGRESS", "running", "running"],
    ...["QUEUED", "WAITING", "PENDING", "REQUESTED"].map((s) => [null, s, "queued", "running"]),
    ["STALE", "COMPLETED", "other", null],
  ])("CheckRun %s/%s を行と見出しに写す", (conclusion, status, outcome, bucket) => {
    const result = checksView([{ __typename: "CheckRun", name: "test", status, conclusion }]);
    expect(result).toEqual({
      checks: [
        {
          name: "test",
          kind: "check_run",
          status: status!.toLowerCase(),
          conclusion: conclusion?.toLowerCase() ?? null,
          state: null,
          outcome,
          startedAt: null,
          completedAt: null,
          detailsUrl: null,
        },
      ],
      counts: {
        success: bucket === "success" ? 1 : 0,
        failure: bucket === "failure" ? 1 : 0,
        running: bucket === "running" ? 1 : 0,
      },
    });
  });
  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "running"],
    ["EXPECTED", "running"],
    ["UNKNOWN", "other"],
  ])("StatusContext %s を行と見出しに写す", (state, outcome) => {
    expect(checksView([{ __typename: "StatusContext", context: "external", state }])).toEqual({
      checks: [
        {
          name: "external",
          kind: "status_context",
          status: null,
          conclusion: null,
          state: state.toLowerCase(),
          outcome,
          startedAt: null,
          completedAt: null,
          detailsUrl: null,
        },
      ],
      counts: {
        success: outcome === "success" ? 1 : 0,
        failure: outcome === "failure" ? 1 : 0,
        running: outcome === "running" ? 1 : 0,
      },
    });
  });
  it("再実行は最新を使い、失敗・実行中・待ち・成功・その他と名前で並べる", () => {
    const input = [
      {
        name: "z",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        createdAt: "2025-12-31T23:59:00Z",
        startedAt: "2026-01-01T00:00:00Z",
      },
      { name: "b", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "a", status: "COMPLETED", conclusion: "CANCELLED" },
      { name: "run", status: "IN_PROGRESS" },
      { name: "wait", status: "QUEUED" },
      { name: "ok", conclusion: "SKIPPED" },
      { name: "other", conclusion: "STALE" },
      {
        name: "z",
        status: "IN_PROGRESS",
        createdAt: "2026-01-01T23:59:00Z",
        startedAt: "2026-01-02T00:00:00Z",
      },
    ];
    expect(checksView(input).checks.map((c) => c.name)).toEqual([
      "a",
      "b",
      "run",
      "z",
      "wait",
      "ok",
      "other",
    ]);
    expect(checksView(input).counts).toEqual({ success: 1, failure: 2, running: 3 });
  });
  it.each([1, 2, 3, 4, 5, 6])("証跡はレベル %i の見出しから同レベルの次まで切り出す", (level) => {
    const h = "#".repeat(level);
    expect(
      evidenceSection(
        `intro\n${h} 動作確認\n![画面](https://example.com/a.png)\n${h}# 子\ntext\n${h} 次\nend`,
      ),
    ).toEqual({
      markdown: `![画面](https://example.com/a.png)\n${h}# 子\ntext`,
      images: [{ alt: "画面", url: "https://example.com/a.png" }],
    });
  });
  it("証跡節が無ければ空を返す", () =>
    expect(evidenceSection("# 説明\ntext")).toEqual({ markdown: "", images: [] }));
  it("コードブロック内の見出しを証跡の境界にしない", () =>
    expect(evidenceSection("## 動作確認\n```md\n## 例\n```\n## 次")).toEqual({
      markdown: "```md\n## 例\n```",
      images: [],
    }));
  const diff =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,2 @@\n same\n-old\n+new value\n";
  it("統一差分を行番号と増減付きのファイルにする", () =>
    expect(parsePrDiff(diff)).toEqual([
      {
        path: "a.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 2,
            oldLines: 2,
            newStart: 2,
            newLines: 2,
            lines: [" same", "-old", "+new value"],
          },
        ],
      },
    ]));
  it.each([
    [sha, "missing", "new", 7, "anything", true],
    ["b".repeat(40), "a.ts", "new", 3, "new", true],
    ["b".repeat(40), "a.ts", "old", 3, "old", true],
    ["b".repeat(40), "a.ts", "new", 3, "old", false],
    ["b".repeat(40), "a.ts", "new", 4, "new", false],
  ])("引用 %s/%s/%s/%i の行が今もあるか判定する", (commit, path, side, line, text, expected) => {
    expect(
      canCommentOnLine(
        {
          kind: "pr_diff",
          mode: "line",
          text: text as string,
          path: path as string,
          commit: commit as string,
          start: { side: side as "old" | "new", line: line as number, col: 0 },
          end: { side: side as "old" | "new", line: line as number, col: 2 },
        },
        sha,
        parsePrDiff(diff),
      ),
    ).toBe(expected);
  });
});

import { beforeAll, afterAll } from "vite-plus/test";
import { createGitPathFixtures, gitPathCases, expectedGitFile } from "../pr-git-test-support";
let gitFixtures: Awaited<ReturnType<typeof createGitPathFixtures>>;
beforeAll(async () => {
  gitFixtures = await createGitPathFixtures();
});
afterAll(() => gitFixtures.remove());
it.each(gitPathCases)(
  "Git の $operation の引用済みパス $name を元の名前で読む",
  ({ operation, name, index }) => {
    const data = gitFixtures.repos.get(operation)!;
    const expected = expectedGitFile(operation, name, index);
    expect(parsePrDiff(data.diff).find((file) => file.path === expected.path)).toEqual(expected);
  },
);

const ghZero = "0001-01-01T00:00:00Z";
it.each(["QUEUED", "WAITING", "PENDING", "REQUESTED"])(
  "gh のゼロ時刻の %s を未開始の待ちとして必ず残す",
  (status) => {
    expect(
      checksView([
        {
          __typename: "CheckRun",
          name: "test",
          status,
          conclusion: "",
          startedAt: ghZero,
          completedAt: ghZero,
          detailsUrl: "https://example.com/job",
        },
      ]),
    ).toEqual({
      checks: [
        {
          name: "test",
          kind: "check_run",
          status: status.toLowerCase(),
          conclusion: "",
          state: null,
          outcome: "queued",
          startedAt: null,
          completedAt: null,
          detailsUrl: "https://example.com/job",
        },
      ],
      counts: { success: 0, failure: 0, running: 1 },
    });
  },
);
it.each([false, true])(
  "gh が StatusContext の日時を startedAt に出しても最新を選ぶ: reverse=%s",
  (reverse) => {
    const latest = {
      __typename: "StatusContext",
      context: "deploy",
      state: "SUCCESS",
      startedAt: "2026-11-28T00:02:00Z",
      targetUrl: "https://example.com/latest",
    };
    const old = {
      ...latest,
      state: "FAILURE",
      startedAt: "2026-11-28T00:01:00Z",
      targetUrl: "https://example.com/old",
    };
    expect(checksView(reverse ? [old, latest] : [latest, old])).toEqual({
      checks: [
        {
          name: "deploy",
          kind: "status_context",
          status: null,
          conclusion: null,
          state: "success",
          outcome: "success",
          startedAt: Date.parse(latest.startedAt),
          completedAt: null,
          detailsUrl: latest.targetUrl,
        },
      ],
      counts: { success: 1, failure: 0, running: 0 },
    });
  },
);
