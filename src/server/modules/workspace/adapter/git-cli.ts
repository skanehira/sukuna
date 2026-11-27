import { runCommand, type CommandOptions, type CommandResult } from "../../../../shared/command";
import { lstat, readFile, appendFile, open, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import {
  WORKTREE_CONFLICT,
  WORKTREE_CHANGED,
  type GitWorktree,
  type WorktreeError,
  type WorktreeGitPort,
} from "../domain/worktree-ports";

export interface GitRunner {
  run(args: string[], opts: CommandOptions): Promise<CommandResult>;
}
export function createGitCli(
  runner: GitRunner = { run: (args, opts) => runCommand("git", args, opts) },
): GitRunner {
  return runner;
}

function gitError(output: string): WorktreeError {
  const lines = output.trim().split(/\r?\n/);
  return {
    code: "worktree_failed",
    message:
      lines.find((line) => /^(fatal|error):/i.test(line)) ??
      lines[0] ??
      "git を実行できませんでした",
  };
}

function parseWorktrees(output: string): GitWorktree[] {
  const entries: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const token of output.split("\0")) {
    if (token.startsWith("worktree ")) {
      current = { path: token.slice(9), head: "", branch: null, locked: null };
      entries.push(current);
    } else if (current && token.startsWith("HEAD ")) current.head = token.slice(5);
    else if (current && token.startsWith("branch "))
      current.branch = token.slice(7).replace(/^refs\/heads\//, "");
    else if (current && (token === "locked" || token.startsWith("locked ")))
      current.locked = token === "locked" ? "" : token.slice(7);
  }
  return entries;
}

const prHeadSchema = z.object({ state: z.string(), headRefOid: z.string() });

export function createWorktreeGit(git: GitRunner, gh: GhRunner): WorktreeGitPort {
  const run = (cwd: string, args: string[]) =>
    ResultAsync.fromPromise(git.run(args, { cwd }), (error) => gitError(String(error))).andThen(
      (result): Result<string, WorktreeError> =>
        result.exitCode === 0 ? ok(result.stdout) : err(gitError(result.stderr || result.stdout)),
    );
  const exists = (path: string) =>
    ResultAsync.fromPromise(lstat(path), (error): WorktreeError => ({
      code: "internal",
      message: String(error),
    }))
      .map(() => true)
      .orElse((error) => (error.message.includes("ENOENT") ? ok(false) : err(error)));
  const unpushed = async (project: { path: string; defaultBranch: string }, head: string) =>
    (
      await run(project.path, [
        "rev-list",
        "--count",
        head,
        "--not",
        "--remotes",
        `refs/heads/${project.defaultBranch}`,
      ])
    ).map((count) => Number(count.trim()));
  return {
    list: async (cwd) =>
      (await run(cwd, ["worktree", "list", "--porcelain", "-z"])).map(parseWorktrees),
    exists: async (path) => exists(path),
    branchExists: async (cwd, branch) => {
      const result = await git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd,
      });
      return result.exitCode === 0
        ? ok(true)
        : result.exitCode === 1
          ? ok(false)
          : err(gitError(result.stderr));
    },
    async status(project, worktree) {
      const present = await exists(worktree.path);
      if (present.isErr()) return err(present.error);
      const paths: string[] = [];
      if (present.value) {
        const status = await run(worktree.path, ["status", "--porcelain=v1", "-z"]);
        if (status.isErr()) return err(status.error);
        const tokens = status.value.split("\0");
        for (let i = 0; i < tokens.length; i += 1) {
          const token = tokens[i]!;
          if (!token) continue;
          paths.push(token.slice(3));
          if (token[0] === "R" || token[0] === "C" || token[1] === "R" || token[1] === "C") i += 1;
        }
      }
      let head = worktree.head;
      let branch = worktree.branch;
      if (present.value) {
        const current = await run(worktree.path, ["rev-parse", "--verify", "HEAD"]);
        if (current.isErr()) return err(current.error);
        head = current.value.trim();
        const symbolic = await git.run(["symbolic-ref", "--quiet", "HEAD"], {
          cwd: worktree.path,
        });
        if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1)
          return err(gitError(symbolic.stderr));
        branch =
          symbolic.exitCode === 0 ? symbolic.stdout.trim().replace(/^refs\/heads\//, "") : null;
      }
      const count = await unpushed(project, head);
      if (count.isErr()) return err(count.error);
      return ok({
        uncommittedCount: paths.length,
        uncommittedSample: paths.slice(0, 5),
        unpushedCount: count.value,
        missing: !present.value,
        head,
        branch,
      });
    },
    async exclude(cwd) {
      const pathResult = await run(cwd, ["rev-parse", "--git-path", "info/exclude"]);
      if (pathResult.isErr()) return err(pathResult.error);
      const path = resolve(cwd, pathResult.value.trim());
      const contents = await ResultAsync.fromPromise(readFile(path, "utf8"), (error) =>
        gitError(String(error)),
      ).orElse((error) => (error.message.includes("ENOENT") ? ok("") : err(error)));
      if (contents.isErr()) return err(contents.error);
      if (contents.value.split(/\r?\n/).includes(".claude/worktrees/")) return ok(undefined);
      return ResultAsync.fromPromise(
        appendFile(
          path,
          `${contents.value && !contents.value.endsWith("\n") ? "\n" : ""}.claude/worktrees/\n`,
        ),
        (error) => gitError(String(error)),
      );
    },
    fetch: async (cwd, branch) =>
      (await run(cwd, ["fetch", "origin", branch])).map(() => undefined),
    async add(cwd, path, branch, start) {
      const result = await run(cwd, [
        "worktree",
        "add",
        ...(start === null ? [path, branch] : ["-b", branch, path, start]),
      ]);
      if (
        result.isErr() &&
        /already exists|already checked out|already used|already registered/.test(
          result.error.message,
        )
      )
        return err(WORKTREE_CONFLICT);
      return result.map(() => undefined);
    },
    remove: async (cwd, path) =>
      (await run(cwd, ["worktree", "remove", path])).map(() => undefined),
    prune: async (cwd) =>
      (await run(cwd, ["worktree", "prune", "--expire", "now"])).map(() => undefined),
    async protect(project, current) {
      const requested: { cwd: string; ref: string }[] = [];
      if (current) {
        requested.push({ cwd: current.path, ref: "HEAD" });
        if (current.branch)
          requested.push({ cwd: project.path, ref: `refs/heads/${current.branch}` });
      }
      const handles: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
      const release = async () => {
        for (const { path, handle } of handles.reverse()) {
          await ResultAsync.fromPromise(
            (async () => {
              const original = await handle.stat({ bigint: true });
              const actual = await lstat(path, { bigint: true }).catch(() => null);
              if (actual && actual.dev === original.dev && actual.ino === original.ino)
                await rm(path);
            })(),
            () => undefined,
          );
          await ResultAsync.fromPromise(handle.close(), () => undefined);
        }
      };
      for (const request of requested) {
        const resolved = await run(request.cwd, ["rev-parse", "--git-path", request.ref]);
        if (resolved.isErr()) {
          await release();
          return err(resolved.error);
        }
        const path = `${resolve(request.cwd, resolved.value.trim())}.lock`;
        if (handles.some((held) => held.path === path)) continue;
        const opened = await ResultAsync.fromPromise(
          (async () => {
            await mkdir(resolve(path, ".."), { recursive: true });
            return open(path, "wx");
          })(),
          () => WORKTREE_CHANGED,
        );
        if (opened.isErr()) {
          await release();
          return err(opened.error);
        }
        handles.push({ path, handle: opened.value });
      }
      if (current) {
        const head = await run(current.path, ["rev-parse", "--verify", "HEAD"]);
        const symbolic = await git.run(["symbolic-ref", "--quiet", "HEAD"], {
          cwd: current.path,
        });
        if (
          head.isErr() ||
          (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) ||
          head.value.trim() !== current.head ||
          (symbolic.exitCode === 0
            ? symbolic.stdout.trim().replace(/^refs\/heads\//, "")
            : null) !== current.branch
        ) {
          await release();
          return err(WORKTREE_CHANGED);
        }
      }
      return ok({ release });
    },
    async mergedPrHeads(cwd, urls) {
      const heads: string[] = [];
      for (const url of urls) {
        const result = await gh.run(["pr", "view", url, "--json", "state,headRefOid"], { cwd });
        if (result.exitCode !== 0) continue;
        const json = Result.fromThrowable((): unknown => JSON.parse(result.stdout))();
        if (json.isErr()) continue;
        const parsed = prHeadSchema.safeParse(json.value);
        if (parsed.success && parsed.data.state === "MERGED") heads.push(parsed.data.headRefOid);
      }
      return heads;
    },
  };
}

import type { PrGitPort } from "../../flow/domain/pr-ports";
import { parsePrDiff } from "../../flow/domain/pr-view";
export function createPrGitCli(runner: GitRunner = createGitCli()): PrGitPort {
  return {
    async read(cwd, branch, baseBranch) {
      const head = await runner.run(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], {
        cwd,
      });
      if (head.exitCode !== 0)
        return err({
          code: "conflict",
          message: "実装のブランチが見つかりません。読み直してください。",
        });
      const diff = await runner.run(
        [
          "diff",
          "--no-ext-diff",
          "--no-color",
          `refs/heads/${baseBranch}...${head.stdout.trim()}`,
          "--",
        ],
        { cwd },
      );
      if (diff.exitCode !== 0)
        return err({
          code: "internal",
          message: "実装のブランチの差分を取得できませんでした。git の状態を確かめてください。",
        });
      return ok({
        branch,
        baseBranch,
        headSha: head.stdout.trim(),
        files: parsePrDiff(diff.stdout),
      });
    },
  };
}
