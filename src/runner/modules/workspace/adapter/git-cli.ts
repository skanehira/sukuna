import { acquireRecordedGitLock } from "../../../../shared/workspace/recorded-lock";
import { createOwnedImplementationCleanup } from "./owned-cleanup";
import {
  physicalDirectory,
  worktreeGitDirectory,
  worktreeRegistration,
} from "../../../../shared/workspace/git-registration";
import { createHash, randomUUID } from "node:crypto";
import { startRefUpdate, updateLocalDesign } from "./local-design-update";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { err, ok } from "neverthrow";
import { designStale, type DesignReflectionPlan } from "../../../../shared/api/design";
import type { DesignProject } from "../../../../shared/design/records";
import { createWorktreeGit } from "../../../../server/modules/workspace/adapter/git-cli";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { ImplementationGit } from "../../flow/domain/impl-ports";
import type { DesignGit, DesignWorkspaceGit, DesignWorktree } from "../../flow/domain/design-ports";
import { runCommand, type CommandOptions, type CommandResult } from "../../../../shared/command";
export interface GitRunner {
  run(args: string[], opts: CommandOptions): Promise<CommandResult>;
}
export function createGitCli(
  runner: GitRunner = { run: (args, opts) => runCommand("git", args, opts) },
): GitRunner {
  return runner;
}

async function isolatedMergeTree(
  git: GitRunner,
  cwd: string,
  oldHead: string,
  base: string,
  approved: string,
  store: "repository" | "temporary",
) {
  const checked = async (cwd: string, args: string[]) => {
    const result = await git.run(args, { cwd });
    return result.exitCode === 0 ? ok(result.stdout.trim()) : err({ message: gitMessage(result) });
  };
  const objectFormat = await checked(cwd, ["rev-parse", "--show-object-format"]);
  if (objectFormat.isErr()) return err(objectFormat.error);
  const objects = await checked(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  if (objects.isErr()) return err(objects.error);
  const temporary = await mkdtemp(join(tmpdir(), "sukuna-design-merge-"));
  let merge: CommandResult;
  try {
    const env = {
      GIT_DIR: temporary,
      GIT_COMMON_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    };
    const initialized = await git.run(
      ["init", "--bare", "--quiet", "--template=", `--object-format=${objectFormat.value}`],
      { cwd: temporary, env },
    );
    if (initialized.exitCode !== 0) return err({ message: gitMessage(initialized) });
    await mkdir(join(temporary, "info"), { recursive: true });
    await writeFile(join(temporary, "info", "attributes"), "* merge=text\n");
    merge = await git.run(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        `--merge-base=${base}`,
        oldHead,
        approved,
      ],
      {
        cwd: temporary,
        env:
          store === "repository"
            ? { ...env, GIT_OBJECT_DIRECTORY: objects.value }
            : { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects.value) },
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return ok(merge);
}

export function createRunnerDesignGit(
  git: GitRunner,
  worktrees: Pick<DesignWorkspaceGit, "list">,
): DesignGit {
  const run = (cwd: string, args: string[]) => git.run(args, { cwd });
  const checked = async (cwd: string, args: string[]) => {
    const result = await run(cwd, args);
    return result.exitCode === 0 ? ok(result.stdout.trim()) : err({ message: gitMessage(result) });
  };
  const head = (cwd: string, ref: string) =>
    checked(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const branchRef = (branch: string) => `refs/heads/${branch}`;
  const localRef = (project: DesignProject) => branchRef(project.defaultBranch);
  const remoteRef = (project: DesignProject) => `refs/remotes/origin/${project.defaultBranch}`;
  const pushRemote = async (cwd: string) => {
    const remotes = await checked(cwd, ["remote", "get-url", "--push", "--all", "origin"]);
    if (remotes.isErr()) return err(remotes.error);
    return remotes.value && !remotes.value.includes("\n")
      ? ok(remotes.value)
      : err({ message: "origin の push 先を1件にしてください" });
  };
  const branchAt = (path: string) => checked(path, ["symbolic-ref", "--quiet", "HEAD"]);
  const canonical = async (path: string) => realpath(path).catch(() => path);

  const changedTarget = {
    message: "既定ブランチか origin が変わりました。反映先を確認してから、もう一度承認してください",
  };
  const differs = (
    scope: Pick<DesignReflectionPlan, "targetRef" | "remoteKey">,
    plan: DesignReflectionPlan,
  ) => scope.targetRef !== plan.targetRef || scope.remoteKey !== plan.remoteKey;
  const ancestor = async (cwd: string, commit: string, tip: string) => {
    const result = await run(cwd, ["merge-base", "--is-ancestor", commit, tip]);
    return result.exitCode === 0
      ? ok(true)
      : result.exitCode === 1
        ? ok(false)
        : err({ message: gitMessage(result) });
  };

  async function applied(
    cwd: string,
    tip: string,
    approved: string,
    scope: Pick<DesignReflectionPlan, "targetRef" | "remoteKey">,
    plan?: DesignReflectionPlan,
  ) {
    if (plan && differs(scope, plan)) return err(changedTarget);
    if (plan) {
      const known = await head(cwd, plan.commit);
      if (known.isOk()) {
        const verified = await ancestor(cwd, known.value, tip);
        if (verified.isErr() || verified.value) return verified;
      }
    }
    return ancestor(cwd, approved, tip);
  }

  async function prepareTree(cwd: string, oldHead: string, base: string, approved: string) {
    if (oldHead === base) return ok(approved);
    const result = await isolatedMergeTree(git, cwd, oldHead, base, approved, "repository");
    if (result.isErr()) return err(result.error);
    const merge = result.value;
    const [tree, conflict] = merge.stdout.split("\0");
    if (merge.exitCode === 1)
      return err({
        message: `既定ブランチの変更と設計書の変更がぶつかりました${conflict ? ` (${conflict.split(/\r?\n/)[0]})` : ""}。差し戻して、AI に既定ブランチを取り込ませてください`,
      });
    if (merge.exitCode !== 0 || !tree)
      return err({ message: `設計書を既定ブランチへ取り込めませんでした: ${gitMessage(merge)}` });
    const currentTree = await checked(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${oldHead}^{tree}`,
    ]);
    if (currentTree.isErr()) return err(currentTree.error);
    if (currentTree.value === tree)
      return err({
        message:
          "既定ブランチに同じ内容があります。承認した版の反映を確認できないため、状態を確認してください",
      });
    return checked(cwd, [
      "-c",
      "user.name=Sukuna",
      "-c",
      "user.email=sukuna@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      oldHead,
      "-m",
      "Reflect approved design",
    ]);
  }

  async function pushDesign(
    project: DesignProject,
    worktree: DesignWorktree,
    base: string,
    approved: string,
    recovery: Parameters<DesignGit["reflect"]>[3],
  ) {
    const remote = await pushRemote(worktree.path);
    if (remote.isErr()) return err(remote.error);
    const scratchRef = `refs/sukuna/design-reflect/${randomUUID()}`;
    const target = localRef(project);
    const scope = {
      targetRef: target,
      remoteKey: createHash("sha256").update(remote.value).digest("hex"),
    };
    const fetched = await checked(worktree.path, [
      "fetch",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      "--",
      remote.value,
      `${target}:${scratchRef}`,
    ]);
    if (fetched.isErr())
      return err({
        message: `GitHub から既定ブランチを取得できませんでした: ${fetched.error.message}。時間をおいて、もう一度承認してください`,
      });
    const current = await head(worktree.path, scratchRef);
    try {
      if (current.isErr()) return err(current.error);
      const present = await applied(worktree.path, current.value, approved, scope, recovery.plan);
      if (present.isErr()) return err(present.error);
      if (present.value) {
        const latest = await checked(worktree.path, [
          "ls-remote",
          "--exit-code",
          "--refs",
          "--",
          remote.value,
          target,
        ]);
        const currentRemote = await pushRemote(worktree.path);
        return latest.isOk() &&
          latest.value === `${current.value}\t${target}` &&
          currentRemote.isOk() &&
          currentRemote.value === remote.value
          ? ok(current.value)
          : err(changedTarget);
      }
      if (!(await stillApproved(worktree, approved))) return err({ message: designStale.message });
      const result = await prepareTree(worktree.path, current.value, base, approved);
      if (result.isErr()) return err(result.error);
      if (!(await stillApproved(worktree, approved))) return err({ message: designStale.message });
      if (!recovery.savePlan({ ...scope, commit: result.value }))
        return err({ message: designStale.message });
      const destination = await pushRemote(worktree.path);
      if (destination.isErr() || destination.value !== remote.value) return err(changedTarget);
      const pushed = await checked(worktree.path, [
        "push",
        "--no-follow-tags",
        "--recurse-submodules=no",
        `--force-with-lease=${target}:${current.value}`,
        "--",
        remote.value,
        `${result.value}:${target}`,
      ]);
      return pushed.isErr()
        ? err({
            message: `既定ブランチへ push できませんでした: ${pushed.error.message}。反映のしかたを PR にすると入れられます`,
          })
        : ok(result.value);
    } finally {
      if (current.isOk())
        await checked(worktree.path, ["update-ref", "-d", scratchRef, current.value]);
    }
  }

  async function stillApproved(tree: DesignWorktree, approved: string) {
    const branch = await branchAt(tree.path);
    if (branch.isErr() || branch.value !== branchRef(tree.branch)) return false;
    const commit = await head(tree.path, branchRef(tree.branch));
    return commit.isOk() && commit.value === approved;
  }

  return {
    head,
    canonical,
    pushRemote,
    async range(project, branch) {
      const tip = await head(project.path, branchRef(branch));
      if (tip.isErr()) return err(tip.error);
      const remote = project.usesGithub && (await head(project.path, remoteRef(project)));
      const baseRef = remote && remote.isOk() ? remote.value : localRef(project);
      const base = await checked(project.path, ["merge-base", baseRef, tip.value]);
      return base.map((baseCommit) => ({ baseCommit, headCommit: tip.value }));
    },
    async hasChanges(cwd, base, headCommit) {
      const result = await run(cwd, [
        "diff",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        base,
        headCommit,
        "--",
      ]);
      return result.exitCode === 0
        ? ok(false)
        : result.exitCode === 1
          ? ok(true)
          : err({ message: gitMessage(result) });
    },
    async protectHead(cwd, branch, expected) {
      const lock = await startRefUpdate(cwd, branchRef(branch), expected);
      return lock
        ? ok({
            release: async () => {
              await lock.finish(false);
            },
          })
        : err({ message: designStale.message });
    },
    async reflect(project, tree, approved, recovery) {
      const { baseCommit, headCommit } = approved;
      if (project.usesGithub) return pushDesign(project, tree, baseCommit, headCommit, recovery);
      const target = localRef(project);
      const current = await head(project.path, target);
      if (current.isErr()) return err(current.error);
      const scope = { targetRef: target, remoteKey: null };
      const present = await applied(project.path, current.value, headCommit, scope, recovery.plan);
      if (present.isErr()) return err(present.error);
      if (present.value) {
        const verified = await startRefUpdate(project.path, target, current.value);
        return verified && (await verified.finish(true)) ? ok(current.value) : err(changedTarget);
      }
      if (!(await stillApproved(tree, headCommit))) return err({ message: designStale.message });
      const prepared = await prepareTree(tree.path, current.value, baseCommit, headCommit);
      if (prepared.isErr()) return err(prepared.error);
      const listed = await worktrees.list(project.path);
      if (listed.isErr()) return err(listed.error);
      const checkout = listed.value.find((entry) => entry.branch === project.defaultBranch);
      if (!checkout)
        return err({
          message:
            "既定ブランチを開いている作業場所がありません。既定ブランチを開き直して、もう一度承認してください",
        });
      if (!(await stillApproved(tree, headCommit))) return err({ message: designStale.message });
      if (!recovery.savePlan({ ...scope, commit: prepared.value }))
        return err({ message: designStale.message });
      return updateLocalDesign(git, (cwd) => worktrees.list(cwd), {
        root: project.path,
        fromWorktree: tree.path,
        ref: target,
        branch: project.defaultBranch,
        expectedCheckout: checkout,
        oldHead: current.value,
        commit: prepared.value,
      });
    },
    async pushBranch(tree, commit, remote) {
      const current = await head(tree.path, branchRef(tree.branch));
      if (current.isErr() || current.value !== commit) return err({ message: designStale.message });
      const pushed = await checked(tree.path, [
        "push",
        "--",
        remote,
        `${commit}:${branchRef(tree.branch)}`,
      ]);
      return pushed.map(() => undefined);
    },
  };
}

export function createImplementationGit(git: GitRunner, gh: GhRunner): ImplementationGit {
  const run = (cwd: string, args: string[]) => git.run(args, { cwd });
  const failure = (result: CommandResult) => ({
    code: "worktree_failed" as const,
    message: gitMessage(result),
  });
  const workspace = createWorktreeGit(git, gh);
  const changed = { message: "記録した worktree の同一性を確認できませんでした" };
  const owns: ImplementationGit["owns"] = (path, identity) => {
    if (!identity || physicalDirectory(path) !== identity.directory) return false;
    const gitDir = worktreeGitDirectory(path);
    return gitDir !== null && worktreeRegistration(gitDir, path)?.id === identity.registration;
  };
  const headAt: ImplementationGit["headAt"] = async (cwd, ref) => {
    const result = await run(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    return result.exitCode === 0 ? ok(result.stdout.trim()) : err(failure(result));
  };

  return {
    ...workspace,
    owns,
    registrationExists(identity) {
      const [gitDir, ...stat] = identity.registration.split("\0");
      return !!gitDir && physicalDirectory(gitDir) === stat.join("\0");
    },
    headAt,
    async comparisonBase(cwd, head, baseTip) {
      if (!baseTip || !/^[0-9a-f]{40}$/.test(baseTip)) return null;
      const result = await run(cwd, ["merge-base", "--all", head, baseTip]);
      const bases = result.stdout.trim().split("\n");
      return result.exitCode === 0 && bases.length === 1 && /^[0-9a-f]{40}$/.test(bases[0]!)
        ? bases[0]!
        : null;
    },
    async sameChange(cwd, previous, current) {
      const forward = await run(cwd, ["merge-base", "--is-ancestor", previous.base, current.base]);
      if (forward.exitCode !== 0) return false;
      const candidate = await run(cwd, ["rev-parse", "--verify", `${current.head}^{tree}`]);
      if (candidate.exitCode !== 0) return false;
      const applied = await isolatedMergeTree(
        git,
        cwd,
        current.base,
        previous.base,
        previous.head,
        "temporary",
      );
      if (applied.isErr() || applied.value.exitCode !== 0) return false;
      const [expected] = applied.value.stdout.split("\0");
      return expected === candidate.stdout.trim();
    },
    async protectTip(cwd, branch, expected, observer) {
      const ref = `refs/heads/${branch}`;
      const format = await run(cwd, ["rev-parse", "--show-ref-format"]);
      if (format.exitCode !== 0 || format.stdout.trim() !== "files") return err(changed);
      const symbolic = await run(cwd, ["symbolic-ref", "--quiet", ref]);
      if (symbolic.exitCode !== 1) return err(changed);
      const location = await run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", ref]);
      if (location.exitCode !== 0) return err(changed);
      let hold: ReturnType<typeof acquireRecordedGitLock>;
      try {
        hold = acquireRecordedGitLock(`${location.stdout.trim()}.lock`, observer);
      } catch {
        return err(changed);
      }
      const current = await headAt(cwd, ref);
      if (current.isErr() || current.value !== expected) {
        hold.release();
        return err(changed);
      }
      return ok({
        release: async () => {
          hold.release();
        },
      });
    },
    async createOwned(cwd, path, branch, start) {
      const common = await run(cwd, ["rev-parse", "--git-common-dir"]);
      if (common.exitCode !== 0) return err(failure(common));
      const registrations = join(await realpath(resolve(cwd, common.stdout.trim())), "worktrees");
      await mkdir(dirname(path), { recursive: true });
      const reserved = await mkdir(path).then(
        () => true,
        () => false,
      );
      if (!reserved) return err(changed);
      const directory = physicalDirectory(path);
      if (!directory) return err(changed);
      const pinned = await open(path, "r").catch(() => null);
      if (!pinned) return err(changed);
      try {
        const row = await pinned.stat({ bigint: true });
        const key = [row.dev, row.ino, row.birthtimeNs].join("\0");
        if (directory !== key || physicalDirectory(path) !== directory) return err(changed);
        const added = await workspace.add(cwd, path, branch, start);
        if (added.isErr()) {
          if (physicalDirectory(path) === directory) await rmdir(path).catch(() => {});
          return err(added.error);
        }
        const gitDir = worktreeGitDirectory(path);
        if (!gitDir || dirname(gitDir) !== registrations) return err(changed);
        const registration = worktreeRegistration(gitDir, path)?.id;
        const identity = registration ? { registration, directory } : null;
        if (!identity || !owns(path, identity)) return err(changed);
        return ok(identity);
      } finally {
        await pinned.close();
      }
    },
    ...createOwnedImplementationCleanup(git, owns),
    async directoryKey(path) {
      const entry = await lstat(path, { bigint: true }).catch(() => null);
      return entry?.isDirectory() ? `${entry.dev}:${entry.ino}` : null;
    },
    canonical: (path) => realpath(path).catch(() => path),
    async origin(cwd) {
      const result = await run(cwd, ["remote", "get-url", "origin"]);
      return result.exitCode === 0 ? ok(result.stdout.trim()) : err(failure(result));
    },
    async contains(cwd, tip, commits) {
      for (const commit of commits) {
        const result = await run(cwd, ["merge-base", "--is-ancestor", commit, tip]);
        if (result.exitCode === 1) return ok(false);
        if (result.exitCode !== 0) return err(failure(result));
      }
      return ok(true);
    },
    async include(cwd, target, identity) {
      if (!owns(target, identity)) return err(changed);
      const patterns = await lstat(join(cwd, ".worktreeinclude")).catch(() => null);
      if (!patterns?.isFile()) return ok(undefined);
      const paths = await run(cwd, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-from=.worktreeinclude",
        "-z",
      ]);
      if (paths.exitCode !== 0) return err(failure(paths));
      const sourceRoot = await realpath(cwd);
      const targetRoot = await realpath(target);
      for (const path of paths.stdout.split("\0").filter(Boolean)) {
        if (path.startsWith(".claude/worktrees/")) continue;
        const ignored = await run(cwd, ["check-ignore", "--quiet", "--", path]);
        if (ignored.exitCode === 1) continue;
        if (ignored.exitCode !== 0) return err(failure(ignored));
        const source = join(sourceRoot, path);
        const destination = join(targetRoot, path);
        if (
          (await realpath(source).catch(() => null)) !== source ||
          !(await lstat(source)).isFile()
        )
          continue;
        try {
          let parent = targetRoot;
          for (const part of dirname(path).split("/")) {
            parent = join(parent, part);
            if ((await realpath(parent).catch(() => null)) === parent) continue;
            if (!owns(target, identity)) return err(changed);
            await mkdir(parent);
            if ((await realpath(parent)) !== parent) throw new Error("リンクされたフォルダです");
          }
          if (!owns(target, identity)) return err(changed);
          await copyFile(source, destination, constants.COPYFILE_EXCL);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
          return err({
            code: "worktree_failed",
            message: "指定されたファイルを worktree に複製できませんでした",
          });
        }
      }
      return owns(target, identity) ? ok(undefined) : err(changed);
    },
  };
}

function gitMessage(result: CommandResult) {
  const lines = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean);
  return (
    lines.find((line) => /^(?:fatal|error):/i.test(line)) ??
    lines[0] ??
    "git を実行できませんでした"
  );
}
