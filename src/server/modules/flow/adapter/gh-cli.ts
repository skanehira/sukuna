import { z } from "zod";
import { err, ok } from "neverthrow";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { PrError, PrGithubPort } from "../domain/pr-ports";
import {
  checksView,
  evidenceSection,
  parsePrDiff,
  latestCheckRows,
  groupCheckRows,
  type RawCheck,
} from "../domain/pr-view";
const rawCheckSchema = z.object({
  __typename: z.string().optional(),
  name: z.string().optional(),
  context: z.string().optional(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  detailsUrl: z.string().nullish(),
  targetUrl: z.string().nullish(),
});
const latestRunsSchema = z.array(
  z.object({
    check_runs: z.array(
      z.object({
        id: z.number().int().positive().optional(),
        node_id: z.string().optional(),
        check_suite: z.object({ id: z.number().int().positive() }).optional(),
        app: z.object({ id: z.number().int().positive(), slug: z.string().optional() }).optional(),
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullish(),
        started_at: z.string().nullish(),
        completed_at: z.string().nullish(),
        details_url: z.string().nullish(),
        html_url: z.string().optional(),
      }),
    ),
  }),
);
type LatestRun = z.infer<typeof latestRunsSchema>[number]["check_runs"][number];
const jobSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
  check_run_url: z.string(),
  created_at: z.string().nullish(),
});
const undetermined = (): PrError => ({
  code: "github_unavailable",
  message: "最新の CI を判定できませんでした。GitHubで検査結果を確認してください。",
});
const headSchema = z.object({
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  headRefOid: z.string().regex(/^[a-f0-9]{40}$/i),
});
const rawFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changeType: z.string().optional(),
});
const filePageSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        files: z.object({
          nodes: z.array(rawFileSchema),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
});
const filesQuery =
  "query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){files(first:100,after:$cursor){nodes{path additions deletions changeType} pageInfo{hasNextPage endCursor}}}}}";
const rawPrSchema = headSchema.extend({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergedAt: z.string().nullable(),
  body: z.string(),
  statusCheckRollup: z.array(rawCheckSchema).nullable(),
  files: z.array(rawFileSchema),
});
const reviewSchema = z.object({ id: z.number(), html_url: z.string() });
const commentSchema = z.object({
  html_url: z.string(),
  path: z.string(),
  body: z.string(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  side: z.string().optional(),
  start_line: z.number().nullish(),
  start_side: z.string().nullish(),
});
const fields =
  "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergedAt,body,statusCheckRollup,files";
function unavailable(stderr: string): PrError {
  const line = stderr.split(/\r?\n/).find((s) => s.trim()) ?? "gh の応答を読み取れませんでした";
  return {
    code: "github_unavailable",
    message: /auth login|not logged|authentication required/i.test(stderr)
      ? "gh にログインしていません。ターミナルで gh auth login を実行してください"
      : `GitHub から PR を取得できませんでした: ${line}`,
  };
}
function parse<S extends z.ZodType>(schema: S, text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}
function asRawRun(run: LatestRun): RawCheck {
  return {
    __typename: "CheckRun",
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    detailsUrl: run.details_url ?? run.html_url,
    runId: run.id,
    suiteId: run.check_suite?.id,
    appId: run.app?.id,
  };
}
async function latestRuns(
  runs: LatestRun[],
  contexts: RawCheck[],
  runner: GhRunner,
  location: { host: string; owner: string; repo: string; headSha: string },
  cwd: string,
) {
  let raw = runs.map(asRawRun);
  if (runs.length + contexts.length > 1) {
    const enriched: RawCheck[] = [];
    for (const run of runs) {
      if (run.id === undefined || run.app?.slug !== "github-actions") return err(undetermined());
      let detail: URL;
      try {
        detail = new URL(run.details_url ?? run.html_url ?? "");
      } catch {
        return err(undetermined());
      }
      const prefix = `/${location.owner}/${location.repo}/actions/runs/`;
      const match = detail.pathname.startsWith(prefix)
        ? detail.pathname.slice(prefix.length).match(/^(\d+)\/job\/(\d+)\/?$/)
        : null;
      if (detail.protocol !== "https:" || detail.host !== location.host || match === null)
        return err(undetermined());
      const jobId = Number(match[2]);
      const response = await runner.run(
        [
          "api",
          `repos/${location.owner}/${location.repo}/actions/jobs/${jobId}`,
          ...(location.host === "github.com" ? [] : ["--hostname", location.host]),
        ],
        { cwd },
      );
      if (response.exitCode !== 0) return err(unavailable(response.stderr));
      const job = parse(jobSchema, response.stdout);
      const apiHost = location.host === "github.com" ? "api.github.com" : location.host;
      const apiPrefix = location.host === "github.com" ? "" : "/api/v3";
      const expectedCheck = `https://${apiHost}${apiPrefix}/repos/${location.owner}/${location.repo}/check-runs/${run.id}`;
      if (
        !job ||
        job.id !== jobId ||
        job.run_id !== Number(match[1]) ||
        job.head_sha !== location.headSha ||
        job.check_run_url !== expectedCheck ||
        !job.created_at ||
        job.created_at.startsWith("0001-01-01T") ||
        !Number.isFinite(Date.parse(job.created_at))
      )
        return err(undetermined());
      enriched.push({
        ...asRawRun(run),
        createdAt: job.created_at,
        workflowRunId: job.run_id,
        runAttempt: job.run_attempt,
      });
    }
    raw = enriched;
  }
  const selected = latestCheckRows([...raw, ...contexts]);
  return selected.ambiguousNames.length ? err(undetermined()) : ok(selected.items);
}
export function createPrGhCli(runner: GhRunner): PrGithubPort {
  return {
    async head(url, cwd) {
      const r = await runner.run(["pr", "view", url, "--json", fields], { cwd });
      if (r.exitCode !== 0) return err(unavailable(r.stderr));
      const data = parse(headSchema, r.stdout);
      return data
        ? ok({ headSha: data.headRefOid, state: data.state.toLowerCase() })
        : err(unavailable("gh の応答を読み取れませんでした"));
    },
    async read(url, cwd) {
      const r = await runner.run(["pr", "view", url, "--json", fields], { cwd });
      if (r.exitCode !== 0) return err(unavailable(r.stderr));
      const data = parse(rawPrSchema, r.stdout);
      if (!data) return err(unavailable("gh の応答を読み取れませんでした"));
      const diff = await runner.run(["pr", "diff", url], { cwd });
      const tooLarge =
        diff.exitCode !== 0 &&
        /too large|exceeded.*(?:limit|maximum)|maximum.*(?:diff|files)|diff.*(?:limit|maximum)/i.test(
          diff.stderr,
        );
      if (diff.exitCode !== 0 && !tooLarge) return err(unavailable(diff.stderr));
      const parsed = parsePrDiff(diff.stdout);
      let metadata = data.files;
      if (metadata.length >= 100) {
        const match = url.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
        if (!match) return err(unavailable("PR の URL を読み取れませんでした"));
        metadata = [];
        let cursor: string | null = null;
        for (;;) {
          const response = await runner.run(
            [
              "api",
              "graphql",
              ...(match[1] === "github.com" ? [] : ["--hostname", match[1]]),
              "--method",
              "POST",
              "--input",
              "-",
            ],
            {
              cwd,
              stdin: JSON.stringify({
                query: filesQuery,
                variables: { owner: match[2], repo: match[3], number: Number(match[4]), cursor },
              }),
            },
          );
          if (response.exitCode !== 0) return err(unavailable(response.stderr));
          const page = parse(filePageSchema, response.stdout)?.data.repository.pullRequest.files;
          if (!page) return err(unavailable("ファイル一覧の応答を読み取れませんでした"));
          metadata.push(...page.nodes);
          if (!page.pageInfo.hasNextPage) break;
          if (page.pageInfo.endCursor === null || page.pageInfo.endCursor === cursor)
            return err(unavailable("ファイル一覧の続きを取得できませんでした"));
          cursor = page.pageInfo.endCursor;
        }
      }
      const files = metadata.map((f) => {
        const detail = parsed.find((p) => p.path === f.path);
        return {
          path: f.path,
          status: detail?.status ?? f.changeType?.toLowerCase() ?? "modified",
          binary: detail?.binary ?? false,
          additions: f.additions,
          deletions: f.deletions,
          hunks: tooLarge ? [] : (detail?.hunks ?? []),
        };
      });
      let rawChecks = data.statusCheckRollup ?? [];
      const competingGroups = [...groupCheckRows(rawChecks)].filter(
        ([, rows]) =>
          rows.length > 1 &&
          rows.some((item) => item.context === undefined && item.__typename !== "StatusContext"),
      );
      if (competingGroups.length) {
        const match = url.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
        if (!match) return err(unavailable("PR の URL を読み取れませんでした"));
        for (const [name, group] of competingGroups) {
          const response = await runner.run(
            [
              "api",
              `repos/${match[2]}/${match[3]}/commits/${data.headRefOid}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
              ...(match[1] === "github.com" ? [] : ["--hostname", match[1]]),
              "--paginate",
              "--slurp",
            ],
            { cwd },
          );
          if (response.exitCode !== 0) return err(unavailable(response.stderr));
          const pages = parse(latestRunsSchema, response.stdout);
          const latest = pages
            ?.flatMap((page) => page.check_runs)
            .filter((run) => run.name === name);
          if (!latest?.length) return err(unavailable("最新の CI の応答を読み取れませんでした"));
          const selected = await latestRuns(
            latest,
            group.filter(
              (item) => item.context !== undefined || item.__typename === "StatusContext",
            ),
            runner,
            { host: match[1], owner: match[2], repo: match[3], headSha: data.headRefOid },
            cwd,
          );
          if (selected.isErr()) return err(selected.error);
          rawChecks = rawChecks.filter((item) => !group.includes(item));
          rawChecks.push(...selected.value);
        }
      }
      if (latestCheckRows(rawChecks).ambiguousNames.length) return err(undetermined());
      return ok({
        pr: {
          number: data.number,
          title: data.title,
          url: data.url,
          state: data.state.toLowerCase() as "open" | "merged" | "closed",
          isDraft: data.isDraft,
          headRefName: data.headRefName,
          headSha: data.headRefOid,
          baseRefName: data.baseRefName,
          mergeable: data.mergeable.toLowerCase() as "mergeable" | "conflicting" | "unknown",
          mergedAt: data.mergedAt === null ? null : Date.parse(data.mergedAt),
        },
        checks: checksView(rawChecks).checks,
        evidence: evidenceSection(data.body),
        files,
        diffTooLarge: tooLarge,
      });
    },
    async review(url, cwd, input) {
      const match = url.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
      if (!match) return err(unavailable("PR の URL を読み取れませんでした"));
      const endpoint = `repos/${match[2]}/${match[3]}/pulls/${match[4]}/reviews`;
      const host = match[1] === "github.com" ? [] : ["--hostname", match[1]];
      const r = await runner.run(["api", endpoint, ...host, "--method", "POST", "--input", "-"], {
        cwd,
        stdin: JSON.stringify(input),
      });
      if (r.exitCode !== 0)
        return err({
          ...unavailable(r.stderr),
          lineRejected:
            input.comments.length > 0 &&
            /HTTP 422/.test(r.stderr) &&
            /line|side|diff|PullRequestReviewComment/i.test(r.stderr),
        });
      const review = parse(reviewSchema, r.stdout);
      if (!review) return err(unavailable("投稿の応答を読み取れませんでした"));
      let commentUrls: string[] = [];
      if (input.comments.length) {
        const comments = await runner.run(
          ["api", `${endpoint}/${review.id}/comments?per_page=100`, ...host],
          { cwd },
        );
        const data =
          comments.exitCode === 0 ? parse(z.array(commentSchema), comments.stdout) : null;
        const remaining = [...(data ?? [])];
        commentUrls = input.comments.map((requested) => {
          const index = remaining.findIndex(
            (c) =>
              c.path === requested.path &&
              c.body === requested.body &&
              (c.line ?? c.original_line) === requested.line &&
              c.side === requested.side &&
              (c.start_line ?? undefined) === requested.start_line &&
              (c.start_side ?? undefined) === requested.start_side,
          );
          return index < 0 ? review.html_url : remaining.splice(index, 1)[0].html_url;
        });
      }
      return ok({ reviewUrl: review.html_url, commentUrls });
    },
  };
}
