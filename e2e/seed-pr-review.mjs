import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [home, originalAgentScript] = process.argv.slice(2);
const root = realpathSync(home);
const cwd = join(root, "pr-review-repo");
const tree = join(cwd, ".claude", "worktrees", "issue-7001");
const repo = "example/pr-review";
const url = `https://github.com/${repo}/pull/7001`;
const branch = "sukuna/issue-7001";

const git = (path, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: path, encoding: "utf8" },
  ).trimEnd();

mkdirSync(cwd);
git(cwd, "init", "-q", "-b", "main");
git(cwd, "remote", "add", "origin", `https://github.com/${repo}.git`);
const source = "calendar.ts";
const save = (path, statement) => {
  writeFileSync(join(path, source), `export const holidayColor = "${statement}";\n`);
  git(path, "add", source);
  git(path, "commit", "-qm", statement);
  return git(path, "rev-parse", "HEAD");
};
const base = save(cwd, "calendarDefault");
git(cwd, "worktree", "add", "-qb", branch, tree);
const head = save(tree, "holidayAccent");
const next = save(tree, "holidayHighlight");
const diff = (hash) => git(tree, "diff", "--no-ext-diff", "--no-color", base, hash);
git(tree, "reset", "--hard", head);

const revisedMarker = join(cwd, ".git", "e2e-review-revised");
const mergedMarker = join(cwd, ".git", "e2e-review-merged");
const pr = (hash, state) => ({
  number: 7001,
  title: "予約カレンダーに祝日を表示する",
  url,
  state,
  isDraft: false,
  headRefName: branch,
  headRefOid: hash,
  baseRefName: "main",
  baseRefOid: base,
  mergeable: "MERGEABLE",
  mergedAt: state === "MERGED" ? "2025-11-25T06:02:00Z" : null,
  mergeCommit: state === "MERGED" ? { oid: next } : null,
  isCrossRepository: false,
  headRepository: { nameWithOwner: repo },
  body: "## 動作確認\n祝日が予約カレンダーに表示されます。\n![祝日を表示したカレンダー](https://evidence.example.test/calendar.svg)",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2025-11-25T06:00:00Z",
      completedAt: "2025-11-25T06:01:22Z",
    },
    {
      __typename: "CheckRun",
      name: "format",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2025-11-25T06:00:00Z",
      completedAt: "2025-11-25T06:00:18Z",
    },
  ],
  files: [{ path: source, additions: 1, deletions: 1 }],
});
const response = (match, stdout, whenFileExists) => ({
  match,
  stdout,
  stderr: "",
  exit_code: 0,
  whenFileExists,
});
const view = "^pr view https://github[.]com/example/pr-review/pull/7001 --json ";
const diffCommand = "^pr diff https://github[.]com/example/pr-review/pull/7001$";
writeFileSync(
  join(root, "gh.json"),
  JSON.stringify({
    responses: [
      response(view, JSON.stringify(pr(next, "MERGED")), mergedMarker),
      response(view, JSON.stringify(pr(next, "OPEN")), revisedMarker),
      response(view, JSON.stringify(pr(head, "OPEN"))),
      response(diffCommand, diff(next), revisedMarker),
      response(diffCommand, diff(head)),
    ],
    fallback: { stdout: "", stderr: "No GitHub fixture matched", exit_code: 1 },
  }),
);
const agent = JSON.parse(readFileSync(originalAgentScript, "utf8"));
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
agent.rules.push(
  {
    match: "祝日の色を見直す",
    steps: [
      { shell: `git reset --hard ${next} && touch ${shellQuote(revisedMarker)}` },
      { text: "予約カレンダーの祝日の色を直しました。" },
      {
        tool: "mcp__sukuna__report_ready_for_merge",
        input: { number: 7001, pr_url: url, head_sha: next, summary: "祝日の色を調整" },
      },
      { end: "success" },
    ],
  },
  {
    match: "^merge を許可されました。",
    steps: [
      { shell: `touch ${shellQuote(mergedMarker)}` },
      {
        tool: "mcp__sukuna__report_implementation_done",
        input: {
          number: 7001,
          pr_url: url,
          merge_commit: next,
          summary: "カレンダーの変更を merge",
        },
      },
      { end: "success" },
    ],
  },
);
writeFileSync(join(root, "agent.json"), JSON.stringify(agent));
writeFileSync(join(root, "pr-review.json"), JSON.stringify({ cwd, tree, branch, base, head, url }));
