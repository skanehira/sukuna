import { err, ok } from "neverthrow";
import { z } from "zod";
import { githubIssueLimit, type GithubIssuePort } from "../usecase/github-import";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { githubRepository as canonicalGithubUrl } from "../../../../shared/gh/repository-url";
import type { ProjectGit } from "../../workspace/domain/project-settings";

export function createProjectGithub(gh: GhRunner) {
  return {
    async inspect(
      origin: string | null,
      cwd: string,
    ): Promise<{ available: boolean; reason?: string }> {
      const repository = origin === null ? null : canonicalGithubUrl(origin);
      if (repository === null) return { available: false };
      const result = await gh.run(["repo", "view", repository, "--json", "nameWithOwner"], { cwd });
      if (result.exitCode === 0) return { available: true };
      return {
        available: false,
        reason: /auth login|not logged|authentication required/i.test(result.stderr)
          ? "gh にログインしていません。ターミナルで gh auth login を実行してください"
          : "GitHub のリポジトリを確認できませんでした。origin と gh の接続を確認してください。",
      };
    },
  };
}

const remoteIssueShape = {
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
};
const listOutput = z.array(
  z.object({
    ...remoteIssueShape,
    labels: z.array(z.object({ name: z.string() })),
    createdAt: z.iso.datetime({ offset: true }).transform((value) => Date.parse(value)),
  }),
);
const viewOutput = z.object({
  ...remoteIssueShape,
  body: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
});

function unavailable(stderr: string) {
  const first = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return {
    code: "github_unavailable" as const,
    message: `${first ?? "GitHub の応答を読み取れませんでした"}。ターミナルで gh auth login を実行し、もう一度試してください。`,
  };
}

export function createGithubIssuePort(
  gh: GhRunner,
  git: Pick<ProjectGit, "origin">,
): GithubIssuePort {
  return {
    async resolve(cwd) {
      const origin = await git.origin(cwd);
      const repository = origin === null ? null : canonicalGithubUrl(origin);
      return repository === null
        ? err({
            code: "github_unavailable",
            message:
              "GitHub のリポジトリを確認できませんでした。origin に GitHub のリポジトリを設定してください。",
          })
        : ok({ cwd, repository: repository.slice("https://".length) });
    },
    async list({ cwd, repository }) {
      const result = await gh.run(
        [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          String(githubIssueLimit),
          "--json",
          "number,title,labels,createdAt,url",
          "--repo",
          repository,
        ],
        { cwd, signal: AbortSignal.timeout(15_000) },
      );
      if (result.exitCode !== 0) return err(unavailable(result.stderr));
      try {
        return ok(
          listOutput.parse(JSON.parse(result.stdout)).map((row) => ({
            ...row,
            labels: row.labels.map(({ name }) => name),
          })),
        );
      } catch {
        return err(unavailable(""));
      }
    },
    async get({ cwd, repository }, number) {
      const result = await gh.run(
        [
          "issue",
          "view",
          String(number),
          "--json",
          "number,title,body,state,url",
          "--repo",
          repository,
        ],
        { cwd, signal: AbortSignal.timeout(15_000) },
      );
      if (result.exitCode !== 0)
        return /Could not resolve to an Issue or PullRequest with the number/i.test(result.stderr)
          ? ok(null)
          : err(unavailable(result.stderr));
      try {
        const issue = viewOutput.parse(JSON.parse(result.stdout));
        return issue.number === number ? ok(issue) : err(unavailable(""));
      } catch {
        return err(unavailable(""));
      }
    },
  };
}
