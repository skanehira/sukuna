import { parseDesignDiff } from "./design-diff";
import type { ClosingGitSummary, LifecycleDependencies } from "../../conversation/domain/lifecycle";
import {
  limitClosingItems,
  parseClosingCommits,
  parseClosingCount,
  parseClosingPrs,
  parseUncommittedPaths,
} from "../../conversation/domain/closing-summary";

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

export function createProjectGit(git: GitRunner): import("../domain/project-settings").ProjectGit {
  const read = async (cwd: string, ...args: string[]) => {
    const result = await git.run(args, { cwd });
    return result.exitCode === 0 ? result.stdout.replace(/\n$/, "") : null;
  };
  const symbolic = (cwd: string, ref: string) => read(cwd, "symbolic-ref", "--quiet", ref);
  const refResolves = async (cwd: string, ref: string) =>
    (await read(cwd, "show-ref", "--verify", "--quiet", ref)) !== null &&
    (await read(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) !== null;
  return {
    async locate(cwd) {
      const path = await read(cwd, "rev-parse", "--show-toplevel");
      if (!path)
        return err({
          code: "not_a_repository",
          message: `Git のリポジトリではありません: ${cwd}。リポジトリのパスを指定してください`,
        });
      const [gitDir, commonDir] = await Promise.all([
        read(path, "rev-parse", "--path-format=absolute", "--git-dir"),
        read(path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ]);
      if (!gitDir || !commonDir)
        return err({ code: "invalid_input", message: "Git の作業場所を確認できませんでした。" });
      if (gitDir === commonDir) return ok({ path, repositoryPath: path });
      const listing = await read(path, "worktree", "list", "--porcelain", "-z");
      const first = listing?.split("\0", 1)[0];
      if (!first?.startsWith("worktree "))
        return err({
          code: "invalid_input",
          message: "Git のリポジトリ本体を確認できませんでした。",
        });
      return ok({ path, repositoryPath: first.slice("worktree ".length) });
    },
    async defaultBranch(cwd, usesGithub) {
      const remoteRoot = "refs/remotes/origin/";
      if (usesGithub) {
        const remote = await symbolic(cwd, `${remoteRoot}HEAD`);
        if (remote?.startsWith(remoteRoot) && (await refResolves(cwd, remote)))
          return ok(remote.slice(remoteRoot.length));
      }
      const head = await symbolic(cwd, "HEAD");
      return head?.startsWith("refs/heads/")
        ? ok(head.slice("refs/heads/".length))
        : err({
            code: "invalid_input",
            message: "既定ブランチが見つかりません。リポジトリ本体でブランチを開いてください。",
          });
    },
    async hasBranch(cwd, branch, usesGithub) {
      if (branch === "HEAD") return false;
      return (
        (await refResolves(cwd, `refs/heads/${branch}`)) ||
        (usesGithub && (await refResolves(cwd, `refs/remotes/origin/${branch}`)))
      );
    },
    origin: (cwd) => read(cwd, "remote", "get-url", "origin"),
  };
}

export function createDesignGit(git: GitRunner) {
  return {
    async diff(cwd: string, base: string, head: string) {
      const result = await git.run(
        [
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          "--patch-with-raw",
          "-z",
          "--find-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-relative",
          "--submodule=short",
          "--no-indent-heuristic",
          "--output-indicator-new=+",
          "--output-indicator-old=-",
          "--output-indicator-context= ",
          base,
          head,
          "--",
        ],
        { cwd },
      );
      return result.exitCode === 0 ? parseDesignDiff(result.stdout) : null;
    },
    async head(cwd: string, branch: string) {
      const result = await git.run(
        ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`],
        { cwd },
      );
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
  };
}

export function createClosingGitCli(
  git: GitRunner,
  gh: GhRunner,
  deadline = () => AbortSignal.timeout(10_000),
): LifecycleDependencies["git"] {
  const timed = async <T extends object>(operation: (signal: AbortSignal) => Promise<T>) => {
    const signal = deadline();
    const timeoutError = "10 秒で取得を打ち切りました";
    let abort = () => {};
    const timeout = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(timeoutError));
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error(timeoutError);
      return { ok: true as const, ...(await Promise.race([operation(signal), timeout])) };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "取得できませんでした",
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const output = (result: CommandResult) => {
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim().split(/\r?\n/)[0] || "コマンドを実行できませんでした");
    return result.stdout;
  };
  return async (cwd, project, firstEventAt): Promise<ClosingGitSummary> => {
    const repo = await timed(async (signal) => {
      const result = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd, signal });
      if (result.exitCode !== 0 && /not a git repository/i.test(result.stderr))
        return { git: false };
      return { git: output(result).trim() === "true" };
    });
    if (repo.ok && !repo.git) return { git: false, outputs: {}, remaining: {} };
    if (!repo.ok)
      return {
        git: true,
        outputs: { commits: repo, prs: repo },
        remaining: { uncommitted: repo, unpushed: repo },
      };
    const run = (signal: AbortSignal, args: string[]) => git.run(args, { cwd, signal });
    const [commits, prs, uncommitted, unpushed] = await Promise.all([
      timed(async (signal) => {
        if (firstEventAt === null) return { items: [], more: 0 };
        const since = Math.floor(firstEventAt / 1000) + 1;
        const result = await run(signal, [
          "log",
          `--since-as-filter=@${since}`,
          "--format=%ct%x09%H%x09%s",
          "HEAD",
        ]);
        if (
          result.exitCode !== 0 &&
          /does not have any commits yet|bad revision 'HEAD'/.test(result.stderr)
        )
          return { items: [], more: 0 };
        return limitClosingItems(parseClosingCommits(output(result)), 50);
      }),
      timed(async (signal) => {
        if (!project.usesGithub || firstEventAt === null) return { items: [] };
        const symbolic = await run(signal, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
        if (symbolic.exitCode === 1) return { items: [] };
        const branch = output(symbolic).trim();
        if (branch === project.defaultBranch) return { items: [] };
        for (let limit = 100; ; limit *= 2) {
          signal.throwIfAborted();
          const result = await gh.run(
            [
              "pr",
              "list",
              "--head",
              branch,
              "--state",
              "all",
              "--json",
              "number,title,url,state,createdAt",
              "--limit",
              String(limit),
            ],
            { cwd, signal },
          );
          const { received, reachedStart, items } = parseClosingPrs(output(result), firstEventAt);
          if (received < limit || reachedStart) return { items };
        }
      }),
      timed(async (signal) => {
        const result = await run(signal, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        return limitClosingItems(parseUncommittedPaths(output(result)), 20);
      }),
      timed(async (signal) => {
        const head = await run(signal, ["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.exitCode === 1) return { count: 0, upstream: false };
        output(head);
        const upstream = await run(signal, ["rev-parse", "--verify", "--quiet", "@{u}"]);
        if (upstream.exitCode === 0) {
          const result = await run(signal, ["rev-list", "--count", "@{u}..HEAD"]);
          return { count: parseClosingCount(output(result)), upstream: true };
        }
        if (
          !/no upstream configured|HEAD does not point to a branch|upstream branch .* not stored/.test(
            upstream.stderr,
          ) &&
          upstream.exitCode !== 1
        )
          output(upstream);
        const result = await run(signal, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
        return { count: parseClosingCount(output(result)), upstream: false };
      }),
    ]);
    return { git: true, outputs: { commits, prs }, remaining: { uncommitted, unpushed } };
  };
}
