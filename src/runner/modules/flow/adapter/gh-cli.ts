import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { CommandResult } from "../../../../shared/command";
import {
  designCommitSchema,
  designPrTargetSchema,
  type DesignPrTarget,
} from "../../../../shared/api/design";
import type { DesignGithub, DesignPr } from "../domain/design-ports";
import { githubRepository as canonicalGithubUrl } from "../../../../shared/gh/repository-url";
import type { GhRunner } from "../../../../shared/gh/gh-runner";

export function createGhCli(runner: GhRunner): GhRunner {
  return runner;
}

const resultSchema = z.object({
  state: z.string(),
  mergeCommit: z.object({ oid: designCommitSchema }).nullish(),
});
const githubRepository = z.object({ nameWithOwner: z.string(), url: z.url() });
const scopedPr = resultSchema.extend({
  url: z.url(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: designCommitSchema,
  isCrossRepository: z.boolean(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
});
const prFields =
  "url,state,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,mergeCommit";
const missingTarget = { message: "設計書の PR のリポジトリを確認できませんでした" };
const unexpectedPr = { message: "承認した設計の PR を確認できませんでした" };

function repositoryOf(url: URL) {
  return `${url.host}${url.pathname}`;
}

function matchesUrl(target: DesignPrTarget, value: string) {
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return false;
  const prefix = `${target.repository.toLowerCase()}/pull/`;
  const path = repositoryOf(url).toLowerCase();
  return path.startsWith(prefix) && /^\d+$/.test(path.slice(prefix.length));
}

function matchedPr(
  row: z.infer<typeof scopedPr>,
  target: DesignPrTarget,
  branch: string,
  approved: string,
): DesignPr | null {
  const name = target.repository.split("/").slice(1).join("/").toLowerCase();
  if (
    row.isCrossRepository ||
    row.baseRefName !== target.base ||
    row.headRefName !== branch ||
    row.headRefOid !== approved ||
    row.headRepository?.nameWithOwner.toLowerCase() !== name ||
    !matchesUrl(target, row.url)
  )
    return null;
  return { url: row.url, state: row.state, mergeCommit: row.mergeCommit?.oid ?? null };
}

function payload<T>(response: CommandResult, schema: z.ZodType<T>, failure: { message: string }) {
  if (response.exitCode !== 0) return err({ message: firstError(response) });
  const parsed = Result.fromThrowable(() => schema.parse(JSON.parse(response.stdout)))();
  return parsed.isOk() ? ok(parsed.value) : err(failure);
}

export function createDesignGithub(runner: GhRunner): DesignGithub {
  return {
    async target(project, remote) {
      const canonical = canonicalGithubUrl(remote);
      if (canonical)
        return ok({ repository: repositoryOf(new URL(canonical)), base: project.defaultBranch });

      if (!remote.startsWith("/")) return err(missingTarget);
      const response = await runner.run(
        ["repo", "view", "--json", "nameWithOwner,url", "--", remote],
        { cwd: project.path },
      );
      const repo = payload(response, githubRepository, missingTarget);
      if (repo.isErr()) return err(repo.error);
      const target = new URL(repo.value.url);
      const parsed = designPrTargetSchema.safeParse({
        repository: repositoryOf(target),
        base: project.defaultBranch,
      });
      return parsed.success &&
        target.protocol === "https:" &&
        target.pathname.toLowerCase() === `/${repo.value.nameWithOwner.toLowerCase()}` &&
        !target.username &&
        !target.password &&
        !target.search &&
        !target.hash
        ? ok(parsed.data)
        : err(missingTarget);
    },
    async create(project, target, branch, title, body) {
      const response = await runner.run(
        [
          "pr",
          "create",
          "--repo",
          target.repository,
          "--base",
          target.base,
          "--head",
          branch,
          "--title",
          title,
          "--body-file",
          "-",
        ],
        { cwd: project.path, stdin: body },
      );
      const url = response.stdout.trim();
      return response.exitCode === 0 && matchesUrl(target, url)
        ? ok(url)
        : err({
            message: `設計書の PR を作れませんでした: ${firstError(response)}。時間をおいて、もう一度承認してください`,
          });
    },
    async find(project, target, branch, approved) {
      const response = await runner.run(
        [
          "pr",
          "list",
          "--repo",
          target.repository,
          "--state",
          "all",
          "--base",
          target.base,
          "--head",
          branch,
          "--json",
          prFields,
        ],
        { cwd: project.path },
      );
      const rows = payload(response, z.array(scopedPr), unexpectedPr);
      if (rows.isErr()) return err(rows.error);
      const candidates = rows.value.flatMap((row) =>
        row.state === "CLOSED" ? [] : (matchedPr(row, target, branch, approved) ?? []),
      );
      return ok(candidates.find(({ state }) => state === "MERGED") ?? candidates[0] ?? null);
    },
    async verify(project, target, url, branch, approved) {
      if (!matchesUrl(target, url)) return err(unexpectedPr);
      const response = await runner.run(["pr", "view", url, "--json", prFields], {
        cwd: project.path,
      });
      const row = payload(response, scopedPr, unexpectedPr);
      if (row.isErr()) return err(row.error);
      const matched = matchedPr(row.value, target, branch, approved);
      return matched?.url === url ? ok(matched) : err(unexpectedPr);
    },
  };
}

function firstError(response: CommandResult) {
  return (
    (response.stderr || response.stdout).trim().split(/\r?\n/)[0] || "GitHub の応答がありません"
  );
}
