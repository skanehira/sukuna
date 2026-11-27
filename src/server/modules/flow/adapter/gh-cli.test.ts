import { prResponseSchema } from "../../../../shared/api/pr";
import { prFixture } from "../pr-test-support";
import type { RawCheck } from "../domain/pr-view";
import { it, expect } from "vite-plus/test";
import { createPrGhCli } from "./gh-cli";
import { rawPr, patch, prUrl, viewArgs } from "../pr-test-support";
import type { CommandOptions } from "../../../../shared/command";
it("100件で切れるghのファイル一覧はGraphQLの全ページで補い、GitHubの順序を保つ", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({
    path: `file-${i}`,
    additions: 1,
    deletions: 0,
    changeType: "ADDED",
  }));
  const last = { path: "last", additions: 2, deletions: 1, changeType: "MODIFIED" };
  const calls: { args: string[]; cwd: string; stdin?: string }[] = [];
  const runner = {
    run: async (args: string[], opts: CommandOptions) => {
      calls.push({ args, ...opts });
      if (args[0] === "pr")
        return {
          stdout: args[1] === "view" ? JSON.stringify({ ...rawPr, files: first }) : patch,
          stderr: "",
          exitCode: 0,
        };
      const variables = JSON.parse(opts.stdin ?? "{}").variables;
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                files: {
                  nodes: variables.cursor === null ? first : [last],
                  pageInfo:
                    variables.cursor === null
                      ? { hasNextPage: true, endCursor: "next" }
                      : { hasNextPage: false, endCursor: "end" },
                },
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    },
  };
  const result = await createPrGhCli(runner).read(prUrl, "/fixture");
  expect(result.isOk() ? result.value.files : null).toEqual(
    [...first, last].map((f) => ({
      path: f.path,
      status: f.changeType.toLowerCase(),
      binary: false,
      additions: f.additions,
      deletions: f.deletions,
      hunks: [],
    })),
  );
  const query =
    "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){files(first:100,after:$cursor){nodes{path additions deletions changeType} pageInfo{hasNextPage endCursor}}}}}";
  expect(calls).toEqual([
    { args: viewArgs, cwd: "/fixture" },
    { args: ["pr", "diff", prUrl], cwd: "/fixture" },
    ...[null, "next"].map((cursor) => ({
      args: ["api", "graphql", "--method", "POST", "--input", "-"],
      cwd: "/fixture",
      stdin: JSON.stringify({
        query,
        variables: { owner: "example", repo: "review-fixture", number: 128, cursor },
      }),
    })),
  ]);
});
it.each(["offline", "invalid", "missing_cursor"])(
  "追加のファイル一覧が %s なら一部の結果を返さず取得失敗にする",
  async (mode) => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      path: `f-${i}`,
      additions: 0,
      deletions: 0,
    }));
    let pages = 0;
    const runner = {
      run: async (args: string[]) => {
        if (args[0] === "pr")
          return {
            stdout: args[1] === "view" ? JSON.stringify({ ...rawPr, files }) : "",
            stderr: "",
            exitCode: 0,
          };
        pages++;
        return mode === "offline"
          ? { stdout: "", stderr: "offline", exitCode: 1 }
          : mode === "invalid"
            ? { stdout: "invalid", stderr: "", exitCode: 0 }
            : {
                stdout: JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        files: { nodes: files, pageInfo: { hasNextPage: true, endCursor: null } },
                      },
                    },
                  },
                }),
                stderr: "",
                exitCode: 0,
              };
      },
    };
    const result = await createPrGhCli(runner).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error.code : "ok").toBe("github_unavailable");
    expect(pages).toBe(1);
  },
);

import { beforeAll, afterAll } from "vite-plus/test";
import { createGitPathFixtures, gitPathCases, expectedGitFile } from "../pr-git-test-support";
import { createPrGitCli } from "../../workspace/adapter/git-cli";
let gitFixtures: Awaited<ReturnType<typeof createGitPathFixtures>>;
beforeAll(async () => {
  gitFixtures = await createGitPathFixtures();
});
afterAll(() => gitFixtures.remove());
it.each(gitPathCases)(
  "本物 git と GitHub の $operation の差分が元のパス $name を指す",
  async ({ operation, name, index }) => {
    const data = gitFixtures.repos.get(operation)!;
    const expected = expectedGitFile(operation, name, index);
    const local = await createPrGitCli().read(data.path, "impl", "main");
    const github = await createPrGhCli({
      run: async (args) => ({
        stdout: args[1] === "view" ? JSON.stringify({ ...rawPr, files: data.files }) : data.diff,
        stderr: "",
        exitCode: 0,
      }),
    }).read(prUrl, data.path);
    expect({
      local: local.isOk()
        ? local.value.files.find((file) => file.path === expected.path)
        : local.error,
      github: github.isOk()
        ? github.value.files.find((file) => file.path === expected.path)
        : github.error,
    }).toEqual({ local: expected, github: expected });
  },
);

it.each(
  ["QUEUED", "SUCCESS", "FAILURE"].flatMap((conclusion) =>
    [false, true].map((reverse) => ({ conclusion, reverse })),
  ),
)(
  "日時が無い同名再実行は GitHub の latest を使う: $conclusion reverse=$reverse",
  async ({ conclusion, reverse }) => {
    const zero = "0001-01-01T00:00:00Z";
    const previous = {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-11-28T00:00:00Z",
      completedAt: "2026-11-28T00:01:00Z",
      detailsUrl: "https://example.com/old",
    };
    const queued = {
      ...previous,
      status: "QUEUED",
      conclusion: "",
      startedAt: zero,
      completedAt: zero,
      detailsUrl: "https://example.com/queued",
    };
    const current = {
      name: "test",
      status: conclusion === "QUEUED" ? "queued" : "completed",
      conclusion: conclusion === "QUEUED" ? null : conclusion.toLowerCase(),
      started_at: conclusion === "QUEUED" ? null : "2026-11-28T00:02:00Z",
      completed_at: conclusion === "QUEUED" ? null : "2026-11-28T00:03:00Z",
      details_url: "https://example.com/current",
    };
    const checks =
      conclusion === "QUEUED"
        ? [previous, queued]
        : [
            queued,
            {
              ...previous,
              conclusion,
              startedAt: current.started_at,
              completedAt: current.completed_at,
            },
          ];
    const calls: { args: string[]; cwd: string; stdin?: string }[] = [];
    const runner = {
      run: async (args: string[], opts: CommandOptions) => {
        calls.push({ args, ...opts });
        return {
          stdout:
            args[0] === "pr"
              ? args[1] === "view"
                ? JSON.stringify({
                    ...rawPr,
                    statusCheckRollup: reverse ? [...checks].reverse() : checks,
                  })
                : patch
              : JSON.stringify([{ check_runs: [current] }]),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const result = await createPrGhCli(runner).read(prUrl, "/fixture");
    expect(result.isOk() ? result.value.checks : result.error).toEqual([
      {
        name: "test",
        kind: "check_run",
        status: current.status,
        conclusion: current.conclusion,
        state: null,
        outcome: conclusion === "QUEUED" ? "queued" : conclusion.toLowerCase(),
        startedAt: current.started_at === null ? null : Date.parse(current.started_at),
        completedAt: current.completed_at === null ? null : Date.parse(current.completed_at),
        detailsUrl: current.details_url,
      },
    ]);
    expect(calls).toEqual([
      { args: viewArgs, cwd: "/fixture" },
      { args: ["pr", "diff", prUrl], cwd: "/fixture" },
      {
        args: [
          "api",
          `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
          "--paginate",
          "--slurp",
        ],
        cwd: "/fixture",
      },
    ]);
  },
);
it.each(["offline", "invalid", "empty"])(
  "最新のCIの補足が %s なら古い成功を返さず取得失敗にする",
  async (mode) => {
    const previous = {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-11-28T00:00:00Z",
      completedAt: "2026-11-28T00:01:00Z",
    };
    const queued = {
      ...previous,
      status: "QUEUED",
      conclusion: "",
      startedAt: "0001-01-01T00:00:00Z",
      completedAt: "0001-01-01T00:00:00Z",
    };
    const result = await createPrGhCli({
      run: async (args) =>
        args[0] === "pr"
          ? {
              stdout:
                args[1] === "view"
                  ? JSON.stringify({ ...rawPr, statusCheckRollup: [previous, queued] })
                  : patch,
              stderr: "",
              exitCode: 0,
            }
          : mode === "offline"
            ? { stdout: "", stderr: "offline", exitCode: 1 }
            : {
                stdout: mode === "invalid" ? "invalid" : JSON.stringify([{ check_runs: [] }]),
                stderr: "",
                exitCode: 0,
              },
    }).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error.code : "ok").toBe("github_unavailable");
  },
);

const orderWaits = ["queued", "waiting", "pending", "requested"];
const orderedRun = (id: number, status: string, conclusion: string | null) => ({
  id,
  node_id: `run-${id}`,
  head_sha: rawPr.headRefOid,
  name: "test",
  status,
  conclusion,
  started_at: status === "completed" ? `2026-11-28T00:0${id === 10 ? 1 : 2}:00Z` : null,
  completed_at: status === "completed" ? `2026-11-28T00:0${id === 10 ? 1 : 2}:30Z` : null,
  details_url: `https://github.com/example/review-fixture/actions/runs/${id + 1000}/job/${id}`,
  check_suite: { id: id + 100 },
  app: { id: 15368, slug: "github-actions" },
});
const orderCases = [
  ...orderWaits.map((status) => ({
    label: `new_${status}`,
    old: orderedRun(10, "completed", "success"),
    current: orderedRun(20, status, null),
  })),
  ...orderWaits.flatMap((status) =>
    ["success", "failure"].map((conclusion) => ({
      label: `old_${status}_new_${conclusion}`,
      old: orderedRun(10, status, null),
      current: orderedRun(20, "completed", conclusion),
    })),
  ),
];
function orderRunner(
  runs: ReturnType<typeof orderedRun>[],
  pagesCount = 1,
  host = "github.com",
  options: {
    general?: boolean;
    generalIds?: number[];
    deny?: boolean;
    sameSuite?: boolean;
    missingCreatedAt?: boolean;
    equalCreatedAt?: boolean;
    attempts?: boolean;
    viewRuns?: ReturnType<typeof orderedRun>[];
    createdAtById?: Record<number, string>;
    wrongCheck?: boolean;
    wrongHead?: boolean;
    wrongRun?: boolean;
    contexts?: RawCheck[];
    reverseRollup?: boolean;
  } = {},
) {
  const calls: { args: string[]; cwd: string; stdin?: string }[] = [];
  const values = runs.map((run) => ({
    ...run,
    details_url: (options.attempts
      ? run.details_url.replace(`/runs/${run.id + 1000}/`, "/runs/1000/")
      : run.details_url
    ).replace("github.com", host),
    check_suite: { id: options.sameSuite ? 777 : run.check_suite.id },
    app:
      options.general || options.generalIds?.includes(run.id)
        ? { id: 999, slug: "external-app" }
        : run.app,
  }));
  let ambiguous = true;
  const asGh = (run: ReturnType<typeof orderedRun>) => ({
    __typename: "CheckRun",
    name: run.name,
    status: run.status.toUpperCase(),
    conclusion: run.conclusion?.toUpperCase() ?? "",
    startedAt: run.started_at ?? "0001-01-01T00:00:00Z",
    completedAt: run.completed_at ?? "0001-01-01T00:00:00Z",
    detailsUrl: run.details_url,
  });
  const jobs = values.map((run) => ({
    id: run.id,
    run_id: (options.attempts ? 1000 : run.id + 1000) + (options.wrongRun ? 1 : 0),
    run_attempt: options.attempts ? (run.id === 10 ? 1 : 2) : 1,
    head_sha: options.wrongHead ? "b".repeat(40) : rawPr.headRefOid,
    check_run_url: `https://${host === "github.com" ? "api.github.com" : host + "/api/v3"}/repos/example/review-fixture/check-runs/${options.wrongCheck ? run.id + 1 : run.id}`,
    created_at:
      options.createdAtById?.[run.id] ??
      (options.missingCreatedAt
        ? null
        : options.equalCreatedAt
          ? "2026-11-28T00:00:00Z"
          : run.id === 10
            ? "2026-11-28T00:00:00Z"
            : "2026-11-28T00:01:30Z"),
  }));
  const runner = {
    run: async (args: string[], opts: CommandOptions) => {
      calls.push({ args: [...args], ...opts });
      if (args[0] === "pr")
        return {
          stdout:
            args[1] === "view"
              ? JSON.stringify({
                  ...rawPr,
                  url: prUrl.replace("github.com", host),
                  statusCheckRollup: ambiguous
                    ? options.reverseRollup
                      ? [
                          ...(options.viewRuns ?? values).map(asGh),
                          ...(options.contexts ?? []),
                        ].reverse()
                      : [...(options.viewRuns ?? values).map(asGh), ...(options.contexts ?? [])]
                    : [],
                })
              : patch,
          stderr: "",
          exitCode: 0,
        };
      if (args[1].includes("/check-runs?"))
        return {
          stdout: JSON.stringify(
            pagesCount === 1
              ? [{ total_count: values.length, check_runs: values }]
              : values.map((run) => ({ total_count: values.length, check_runs: [run] })),
          ),
          stderr: "",
          exitCode: 0,
        };
      const id = Number(args[1].split("/").at(-1));
      const job = jobs.find((job) => job.id === id);
      return options.deny
        ? {
            stdout: "",
            stderr: "Resource not accessible by personal access token (HTTP 403)",
            exitCode: 1,
          }
        : job
          ? { stdout: JSON.stringify(job), stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "unknown fixture request", exitCode: 1 };
    },
  };
  return {
    runner,
    calls,
    jobs,
    values,
    normal: () => {
      ambiguous = false;
    },
    ambiguous: () => {
      ambiguous = true;
    },
  };
}
function orderedCheck(run: ReturnType<typeof orderedRun>, host = "github.com") {
  return {
    name: "test",
    kind: "check_run",
    status: run.status,
    conclusion: run.conclusion,
    state: null,
    outcome: run.status === "completed" ? run.conclusion : "queued",
    startedAt: run.started_at === null ? null : Date.parse(run.started_at),
    completedAt: run.completed_at === null ? null : Date.parse(run.completed_at),
    detailsUrl: run.details_url.replace("github.com", host),
  };
}
function orderedRead(run: ReturnType<typeof orderedRun>, host = "github.com") {
  return {
    pr: {
      number: 128,
      title: "テスト",
      url: prUrl.replace("github.com", host),
      state: "open",
      isDraft: false,
      headRefName: "impl",
      headSha: rawPr.headRefOid,
      baseRefName: "main",
      mergeable: "mergeable",
      mergedAt: null,
    },
    checks: [orderedCheck(run, host)],
    evidence: {
      markdown: "![画面](https://example.com/screen.png)",
      images: [{ alt: "画面", url: "https://example.com/screen.png" }],
    },
    files: [
      {
        path: "a.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    ],
    diffTooLarge: false,
  };
}
it.each(
  orderCases.flatMap((pair) =>
    [false, true].flatMap((reverse) => [1, 2].map((pages) => ({ ...pair, reverse, pages }))),
  ),
)(
  "同名の補足候補は作成情報で最新を確定する: $label reverse=$reverse pages=$pages",
  async ({ old, current, reverse, pages }) => {
    const f = orderRunner(reverse ? [old, current] : [current, old], pages);
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isOk() ? result.value : result.error).toEqual(orderedRead(current));
    expect(f.calls).toEqual([
      { args: viewArgs, cwd: "/fixture" },
      { args: ["pr", "diff", prUrl], cwd: "/fixture" },
      {
        args: [
          "api",
          `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
          "--paginate",
          "--slurp",
        ],
        cwd: "/fixture",
      },
      ...f.values.map((run) => ({
        args: ["api", `repos/example/review-fixture/actions/jobs/${run.id}`],
        cwd: "/fixture",
      })),
    ]);
  },
);
it.each(["queued", "success", "failure"])(
  "補足が一件の正常対照は余分な取得をせず表示する: %s",
  (outcome) => {
    const current = orderedRun(
      20,
      outcome === "queued" ? "queued" : "completed",
      outcome === "queued" ? null : outcome,
    );
    const f = orderRunner([current], 1, "github.com", {
      viewRuns: [orderedRun(10, "completed", "success"), orderedRun(20, "queued", null)],
    });
    return createPrGhCli(f.runner)
      .read(prUrl, "/fixture")
      .then((result) => {
        expect(result.isOk() ? result.value : result.error).toEqual(orderedRead(current));
        expect(f.calls).toEqual([
          { args: viewArgs, cwd: "/fixture" },
          { args: ["pr", "diff", prUrl], cwd: "/fixture" },
          {
            args: [
              "api",
              `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
              "--paginate",
              "--slurp",
            ],
            cwd: "/fixture",
          },
        ]);
      });
  },
);
it.each([false, true])(
  "一般Appの公開時刻が同じ二履歴は並びに依存せず判定不能にする: reverse=%s",
  async (reverse) => {
    const old = orderedRun(10, "queued", null);
    const current = orderedRun(20, "completed", "success");
    const f = orderRunner(reverse ? [old, current] : [current, old], 2, "github.com", {
      general: true,
    });
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error : result.value.checks).toEqual({
      code: "github_unavailable",
      message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
    });
  },
);
it.each([false, true])(
  "同じsuite/workflowの再実行は同時刻でもattemptで新旧を決める: reverse=%s",
  async (reverse) => {
    const old = orderedRun(10, "queued", null);
    const current = orderedRun(20, "completed", "failure");
    const f = orderRunner(reverse ? [old, current] : [current, old], 2, "github.com", {
      sameSuite: true,
      equalCreatedAt: true,
      attempts: true,
    });
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isOk() ? result.value.checks : result.error).toEqual([
      {
        ...orderedCheck(current),
        detailsUrl: current.details_url.replace("/runs/1020/", "/runs/1000/"),
      },
    ]);
  },
);
it.each([false, true])(
  "異なるworkflowで作成時刻が同じならID順を仮定せず判定不能にする: reverse=%s",
  async (reverse) => {
    const old = orderedRun(10, "queued", null);
    const current = orderedRun(20, "completed", "success");
    const f = orderRunner(reverse ? [old, current] : [current, old], 1, "github.com", {
      equalCreatedAt: true,
    });
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error : result.value.checks).toEqual({
      code: "github_unavailable",
      message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
    });
  },
);
it("run IDが大きい古い待機も作成時刻で新しい完了と区別する", async () => {
  const old = orderedRun(900, "queued", null);
  const current = orderedRun(20, "completed", "success");
  const f = orderRunner([old, current], 2, "github.com", {
    createdAtById: { 900: "2026-11-28T00:00:00Z", 20: "2026-11-28T00:01:30Z" },
  });
  const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
  expect(result.isOk() ? result.value.checks : result.error).toEqual([orderedCheck(current)]);
});
it("Enterprise の補足とjob取得の両方で指定のhostnameを保つ", async () => {
  const old = orderedRun(10, "completed", "success");
  const current = orderedRun(20, "queued", null);
  const host = "github.example.test";
  const url = prUrl.replace("github.com", host);
  const f = orderRunner([current, old], 2, host);
  const result = await createPrGhCli(f.runner).read(url, "/fixture");
  expect(result.isOk() ? result.value.checks : result.error).toEqual([orderedCheck(current, host)]);
  expect(f.calls).toEqual([
    { args: viewArgs.map((arg) => (arg === prUrl ? url : arg)), cwd: "/fixture" },
    { args: ["pr", "diff", url], cwd: "/fixture" },
    {
      args: [
        "api",
        `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
        "--hostname",
        host,
        "--paginate",
        "--slurp",
      ],
      cwd: "/fixture",
    },
    ...f.values.map((run) => ({
      args: ["api", `repos/example/review-fixture/actions/jobs/${run.id}`, "--hostname", host],
      cwd: "/fixture",
    })),
  ]);
});
it.each(["created_at", "check_run_url", "head_sha"])(
  "Actionsの一次情報 %s が無いか異なれば推測で選ばない",
  async (field) => {
    const f = orderRunner(
      [orderedRun(10, "completed", "success"), orderedRun(20, "queued", null)],
      1,
      "github.com",
      {
        missingCreatedAt: field === "created_at",
        wrongCheck: field === "check_run_url",
        wrongHead: field === "head_sha",
      },
    );
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error : result.value.checks).toEqual({
      code: "github_unavailable",
      message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
    });
  },
);
it.each(
  ["unknown", "permission"].flatMap((problem) =>
    [false, true].flatMap((cache) => [false, true].map((mixed) => ({ problem, cache, mixed }))),
  ),
)(
  "判定不能と権限失敗は保存済み内容を最新として書き換えない: $problem cache=$cache mixed=$mixed",
  async ({ problem, cache, mixed }) => {
    const fakes = orderRunner(
      [orderedRun(10, "completed", "success"), orderedRun(20, "queued", null)],
      2,
      "github.com",
      {
        general: problem === "unknown",
        deny: problem === "permission",
        contexts: mixed ? [mixedContext(false)] : [],
        viewRuns: mixed ? [orderedRun(20, "completed", "failure")] : undefined,
      },
    );
    const f = prFixture({ gh: fakes.runner });
    let saved: ReturnType<typeof prResponseSchema.parse> | undefined;
    if (cache) {
      fakes.normal();
      const first = await f.request();
      expect(first.status).toBe(200);
      saved = prResponseSchema.parse(await first.json());
      expect(saved.fetchedAt).toBe(1000);
      f.deps.now = () => 2000;
      fakes.ambiguous();
    }
    const response = await f.request();
    const message =
      problem === "unknown"
        ? "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。"
        : "GitHub から PR を取得できませんでした: Resource not accessible by personal access token (HTTP 403)";
    expect([response.status, await response.json()]).toEqual(
      cache
        ? [200, { ...saved, fetchError: message }]
        : [502, { error: { code: "github_unavailable", message } }],
    );
  },
);

it.each([false, true])(
  "異なるAppの同名候補も不明な日時をIDで補わない: reverse=%s",
  async (reverse) => {
    const old = orderedRun(10, "queued", null);
    const current = orderedRun(20, "completed", "success");
    const f = orderRunner(reverse ? [old, current] : [current, old], 2, "github.com", {
      generalIds: [10],
    });
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isErr() ? result.error : result.value).toEqual({
      code: "github_unavailable",
      message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
    });
  },
);

it.each(
  ["rollup", "supplement"].flatMap((source) =>
    ["started", "completed-only"].flatMap((timestamp) =>
      [false, true].flatMap((general) =>
        [false, true].map((reverse) => ({ source, timestamp, general, reverse })),
      ),
    ),
  ),
)(
  "開始・完了順が作成順と逆でも最新の作成を使う: $source/$timestamp general=$general reverse=$reverse",
  async ({ source, timestamp, general, reverse }) => {
    const old = {
      ...orderedRun(10, "completed", "success"),
      started_at: timestamp === "started" ? "2026-11-28T00:03:00Z" : null,
      completed_at: "2026-11-28T00:04:00Z",
    };
    const current = {
      ...orderedRun(20, "completed", "failure"),
      started_at: timestamp === "started" ? "2026-11-28T00:02:00Z" : null,
      completed_at: "2026-11-28T00:02:30Z",
    };
    const runs = reverse ? [current, old] : [old, current];
    const f = orderRunner(runs, 2, "github.com", {
      general,
      viewRuns:
        source === "rollup"
          ? runs
          : [orderedRun(10, "completed", "success"), orderedRun(20, "queued", null)],
    });
    const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
    expect(result.isOk() ? result.value : result.error).toEqual(
      general
        ? {
            code: "github_unavailable",
            message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
          }
        : orderedRead(current),
    );
    expect(f.calls).toEqual([
      { args: viewArgs, cwd: "/fixture" },
      { args: ["pr", "diff", prUrl], cwd: "/fixture" },
      {
        args: [
          "api",
          `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
          "--paginate",
          "--slurp",
        ],
        cwd: "/fixture",
      },
      ...(general
        ? []
        : runs.map((run) => ({
            args: ["api", `repos/example/review-fixture/actions/jobs/${run.id}`],
            cwd: "/fixture",
          }))),
    ]);
  },
);

function mixedContext(newer: boolean) {
  return {
    __typename: "StatusContext",
    context: "test",
    state: "SUCCESS",
    startedAt: newer ? "2026-11-28T00:02:00Z" : "2026-11-28T00:00:30Z",
    targetUrl: "https://external.example/test",
  };
}
function contextCheck(context: ReturnType<typeof mixedContext>) {
  return {
    name: "test",
    kind: "status_context",
    status: null,
    conclusion: null,
    state: "success",
    outcome: "success",
    startedAt: Date.parse(context.startedAt),
    completedAt: null,
    detailsUrl: context.targetUrl,
  };
}
it.each(
  ["rollup-single", "supplement-single", "supplement-multiple"].flatMap((source) =>
    [false, true].flatMap((contextNewer) =>
      [false, true].flatMap((reverse) =>
        ["github.com", "github.example.test"].map((host) => ({
          source,
          contextNewer,
          reverse,
          host,
        })),
      ),
    ),
  ),
)(
  "同じ表示名の全種類を作成順で比べる: $source contextNewer=$contextNewer reverse=$reverse host=$host",
  async ({ source, contextNewer, reverse, host }) => {
    const old = orderedRun(10, "completed", "success");
    const current = orderedRun(20, "completed", "failure");
    const context = mixedContext(contextNewer);
    const initial = source === "rollup-single" ? [current] : [old, current];
    const supplemental = source === "supplement-multiple" ? [old, current] : [current];
    const runs = reverse ? [...supplemental].reverse() : supplemental;
    const f = orderRunner(runs, 2, host, {
      viewRuns: initial,
      contexts: [context],
      reverseRollup: reverse,
    });
    const url = prUrl.replace("github.com", host);
    const result = await createPrGhCli(f.runner).read(url, "/fixture");
    expect(result.isOk() ? result.value : result.error).toEqual({
      ...orderedRead(current, host),
      checks: [contextNewer ? contextCheck(context) : orderedCheck(current, host)],
    });
    const hostname = host === "github.com" ? [] : ["--hostname", host];
    expect(f.calls).toEqual([
      { args: viewArgs.map((arg) => (arg === prUrl ? url : arg)), cwd: "/fixture" },
      { args: ["pr", "diff", url], cwd: "/fixture" },
      {
        args: [
          "api",
          `repos/example/review-fixture/commits/${rawPr.headRefOid}/check-runs?check_name=test&filter=latest&per_page=100`,
          ...hostname,
          "--paginate",
          "--slurp",
        ],
        cwd: "/fixture",
      },
      ...runs.map((run) => ({
        args: ["api", `repos/example/review-fixture/actions/jobs/${run.id}`, ...hostname],
        cwd: "/fixture",
      })),
    ]);
  },
);
it.each(["run", "context"])("単独の %s は比較相手が無いので余分な取得をしない", async (kind) => {
  const current = orderedRun(20, "completed", "failure");
  const context = mixedContext(true);
  const f = orderRunner(kind === "run" ? [current] : [], 1, "github.com", {
    contexts: kind === "context" ? [context] : [],
  });
  const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
  expect(result.isOk() ? result.value : result.error).toEqual({
    ...orderedRead(current),
    checks: [kind === "run" ? orderedCheck(current) : contextCheck(context)],
  });
  expect(f.calls).toEqual([
    { args: viewArgs, cwd: "/fixture" },
    { args: ["pr", "diff", prUrl], cwd: "/fixture" },
  ]);
});
it.each([
  "general",
  "permission",
  "missing_created",
  "same_time",
  "wrong_run",
  "wrong_head",
  "wrong_check",
])("混在時の一次情報が %s なら確定せず既存のエラーへ進む", async (problem) => {
  const context = mixedContext(false);
  const f = orderRunner([orderedRun(20, "completed", "failure")], 1, "github.com", {
    contexts: [context],
    general: problem === "general",
    deny: problem === "permission",
    missingCreatedAt: problem === "missing_created",
    createdAtById: problem === "same_time" ? { 20: context.startedAt } : undefined,
    wrongRun: problem === "wrong_run",
    wrongHead: problem === "wrong_head",
    wrongCheck: problem === "wrong_check",
  });
  const result = await createPrGhCli(f.runner).read(prUrl, "/fixture");
  expect(result.isErr() ? result.error : result.value).toEqual({
    code: "github_unavailable",
    message:
      problem === "permission"
        ? "GitHub から PR を取得できませんでした: Resource not accessible by personal access token (HTTP 403)"
        : "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
  });
});
