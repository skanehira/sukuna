import type { PrCheck, PrResponse } from "../../../shared/api/pr";

export const sha = "9".repeat(40);
export const base: PrResponse = {
  issueId: "i",
  source: "github",
  pr: {
    number: 128,
    title: "予約カレンダーに祝日を表示する",
    url: "https://github.com/o/r/pull/128",
    state: "open",
    isDraft: false,
    headRefName: "sukuna/issue-8",
    headSha: sha,
    baseRefName: "main",
    mergeable: "mergeable",
    mergedAt: null,
  },
  checks: [],
  evidence: { markdown: "", images: [] },
  files: [],
  local: null,
  diffTooLarge: false,
  earlierPrUrls: [],
  fetchedAt: new Date(2025, 10, 25, 15, 20).getTime(),
  fetchError: null,
  waitingMergeConfirm: true,
  implConversationId: "c",
  worktree: null,
  unsentInstructionCount: 1,
};
export const file = {
  path: "src/calendar/holiday.ts",
  status: "modified",
  binary: false,
  additions: 2,
  deletions: 1,
  hunks: [
    {
      oldStart: 18,
      oldLines: 2,
      newStart: 19,
      newLines: 3,
      lines: [
        "-const days = fetchHolidays()",
        "+const days = fetchHolidays(year)",
        " ",
        "+return days",
      ],
    },
  ],
};
export const check = (name: string, outcome: PrCheck["outcome"]): PrCheck => ({
  name,
  kind: "check_run",
  status: "completed",
  conclusion: null,
  state: null,
  outcome,
  startedAt: base.fetchedAt - 90_000,
  completedAt: outcome === "running" ? null : base.fetchedAt - 30_000,
  detailsUrl: null,
});
