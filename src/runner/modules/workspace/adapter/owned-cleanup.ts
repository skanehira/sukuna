import {
  acquireRecordedGitLock,
  isStagedGitLock,
  releaseRecordedGitLock,
} from "../../../../shared/workspace/recorded-lock";
import { lstatSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { err, ok } from "neverthrow";
import {
  physicalDirectory,
  physicalFile,
  worktreeGitDirectory,
  worktreeRegistration,
} from "../../../../shared/workspace/git-registration";
import type { GitRunner } from "./git-cli";
import type {
  ImplementationGit,
  ImplementationIdentity,
  ImplementationTree,
} from "../../flow/domain/impl-ports";

const mismatch = "記録した worktree の同一性を確認できませんでした";

function adminProof(identity: ImplementationIdentity) {
  const [path = "", ...key] = identity.registration.split("\0");
  return { path, key: key.join("\0") };
}

function present(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

function privateStage(original: string, stage: string) {
  const root = dirname(stage);
  try {
    const state = lstatSync(root);
    return (
      dirname(root) === dirname(original) &&
      basename(root).startsWith(".sukuna-remove-") &&
      basename(stage) === "worktree" &&
      state.isDirectory() &&
      (state.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

function removeContainer(path: string) {
  try {
    rmdirSync(path);
  } catch {
    return;
  }
}

export function createOwnedImplementationCleanup(
  git: GitRunner,
  owns: ImplementationGit["owns"],
): Pick<ImplementationGit, "removeOwned" | "recoverLocks" | "recoverOwned"> {
  const run = (cwd: string, args: string[]) => git.run(args, { cwd });
  async function noSubmoduleData(cwd: string, admin: string, path: string, common?: string) {
    const list = await git.run(
      ["--git-dir", admin, "--work-tree", path, "ls-files", "--stage", "-z"],
      { cwd, ...(common ? { env: { GIT_COMMON_DIR: common } } : {}) },
    );
    if (list.exitCode !== 0) return false;
    for (const entry of list.stdout.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const separator = entry.indexOf("\t");
      if (separator < 0) return false;
      const submodule = resolve(path, entry.slice(separator + 1));
      if (!submodule.startsWith(path + sep)) return false;
      try {
        const directory = lstatSync(submodule, { throwIfNoEntry: false });
        if (directory && (!directory.isDirectory() || readdirSync(submodule).length > 0))
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  const bound = (at: string, identity: ImplementationIdentity, admin: string) =>
    physicalDirectory(at) === identity.directory && worktreeGitDirectory(at) === admin;

  function recoverLocks(tree: ImplementationTree) {
    if (!tree.identity) return;
    const admin = adminProof(tree.identity);
    const common = dirname(dirname(admin.path));
    const heads = join(common, "refs/heads") + sep;
    const known = new Set([
      join(admin.path, "HEAD.lock"),
      join(admin.path, "locked"),
      join(common, "refs/heads", `${tree.branch}.lock`),
    ]);
    const stagedAdmin =
      tree.cleanupPath && privateStage(tree.path, tree.cleanupPath)
        ? join(dirname(tree.cleanupPath), "registration")
        : undefined;
    for (const file of tree.cleanupLocks) {
      if (
        stagedAdmin &&
        physicalDirectory(stagedAdmin) === admin.key &&
        dirname(file.path) === admin.path &&
        known.has(file.path)
      ) {
        const relocated = {
          ...file,
          path: join(stagedAdmin, basename(file.path)),
          ...(file.stagedPath
            ? { stagedPath: join(stagedAdmin, file.stagedPath.slice(admin.path.length + 1)) }
            : {}),
        };
        if (!relocated.stagedPath || isStagedGitLock(relocated)) releaseRecordedGitLock(relocated);
      }
      if (
        known.has(file.path) ||
        (file.path.startsWith(heads) &&
          resolve(file.path) === file.path &&
          file.path.endsWith(".lock") &&
          isStagedGitLock(file))
      )
        releaseRecordedGitLock(file);
    }
  }

  return {
    recoverLocks,
    async removeOwned(cwd, original, identity, cleanupPath, expected, planned, observer) {
      const admin = adminProof(identity);
      const source =
        cleanupPath && privateStage(original, cleanupPath) && owns(cleanupPath, identity)
          ? cleanupPath
          : original;
      if (!owns(source, identity) || !(await noSubmoduleData(cwd, admin.path, source)))
        return err({ message: mismatch });
      const container =
        source === original
          ? await mkdtemp(join(dirname(original), ".sukuna-remove-"))
          : dirname(source);
      const stage = join(container, "worktree");
      const registration = join(container, "registration");
      const lockPath = join(admin.path, "locked");
      let lock: ReturnType<typeof acquireRecordedGitLock> | undefined;

      try {
        if (!owns(source, identity)) return err({ message: mismatch });
        try {
          lock = acquireRecordedGitLock(lockPath, observer, "sukuna implementation cleanup\n");
        } catch {
          return err({ message: mismatch });
        }
        if (!lock || !owns(source, identity)) return err({ message: mismatch });
        planned(stage, false);

        const sameRegistration = () =>
          worktreeRegistration(admin.path, source)?.id === identity.registration &&
          physicalFile(lockPath) === lock?.file.key;
        if (!sameRegistration() || !bound(source, identity, admin.path))
          return err({ message: mismatch });

        // Git の登録先を変えると、一時パスも通常の worktree move の対象になる。
        if (source !== stage) renameSync(source, stage);
        const head = await run(cwd, ["--git-dir", admin.path, "rev-parse", "--verify", "HEAD"]);
        const branch = await run(cwd, ["--git-dir", admin.path, "symbolic-ref", "--quiet", "HEAD"]);
        const status = await run(cwd, [
          "--git-dir",
          admin.path,
          "--work-tree",
          stage,
          "status",
          "--porcelain=v1",
          "-z",
        ]);
        const canRemove = await noSubmoduleData(cwd, admin.path, stage);
        if (
          !canRemove ||
          !bound(stage, identity, admin.path) ||
          !sameRegistration() ||
          head.exitCode !== 0 ||
          head.stdout.trim() !== expected.head ||
          branch.exitCode !== 0 ||
          branch.stdout.trim() !== `refs/heads/${expected.branch}` ||
          status.exitCode !== 0 ||
          status.stdout !== ""
        ) {
          if (
            source !== stage &&
            !present(source) &&
            bound(stage, identity, admin.path) &&
            sameRegistration()
          )
            renameSync(stage, source);
          return err({ message: mismatch, ...(present(stage) ? { retainedPath: stage } : {}) });
        }

        renameSync(admin.path, registration);
        if (physicalDirectory(registration) !== admin.key || !bound(stage, identity, admin.path))
          return err({ message: mismatch, retainedPath: stage });
        planned(stage, true);
        rmSync(stage, { recursive: true });
        rmSync(registration, { recursive: true });
        return ok(undefined);
      } catch {
        return err({ message: mismatch, ...(present(stage) ? { retainedPath: stage } : {}) });
      } finally {
        lock?.release();
        removeContainer(container);
      }
    },
    async recoverOwned(project, tree) {
      const { path, identity, cleanupPath: stage } = tree;
      if (!identity) return { state: "kept", path };
      const admin = adminProof(identity);
      const common = dirname(dirname(admin.path));
      try {
        recoverLocks(tree);
        if (!stage) return owns(path, identity) ? { state: "restored" } : { state: "kept", path };
        if (!privateStage(path, stage)) {
          return tree.cleanupDetached &&
            !present(stage) &&
            physicalDirectory(admin.path) !== admin.key
            ? { state: "removed" }
            : owns(path, identity)
              ? { state: "restored" }
              : { state: "kept", path };
        }
        const registration = join(dirname(stage), "registration");
        const stagedAdmin = physicalDirectory(registration);
        const stagedDirectory = physicalDirectory(stage);
        if (
          (stagedAdmin === admin.key || tree.cleanupDetached) &&
          (stagedAdmin === admin.key || !present(registration)) &&
          (stagedDirectory === identity.directory || !present(stage)) &&
          physicalDirectory(admin.path) !== admin.key
        ) {
          if (stagedDirectory === identity.directory) {
            if (
              stagedAdmin !== admin.key ||
              !(await noSubmoduleData(project.path, registration, stage, common)) ||
              !bound(stage, identity, admin.path) ||
              physicalDirectory(registration) !== admin.key
            )
              return { state: "kept", path: stage };
            rmSync(stage, { recursive: true });
          }
          if (stagedAdmin === admin.key) rmSync(registration, { recursive: true });
          removeContainer(dirname(stage));
          return { state: "removed" };
        }

        if (owns(path, identity)) return { state: "restored" };
        if (owns(stage, identity) && !present(path)) {
          const restored = await run(project.path, ["worktree", "move", stage, path]);
          if (restored.exitCode === 0 && owns(path, identity)) {
            removeContainer(dirname(stage));
            return { state: "restored" };
          }
        }
        if (
          bound(stage, identity, admin.path) &&
          !present(path) &&
          worktreeRegistration(admin.path, path)?.id === identity.registration
        ) {
          renameSync(stage, path);
          if (owns(path, identity)) {
            removeContainer(dirname(stage));
            return { state: "restored" };
          }
        }
        return { state: "kept", path: bound(stage, identity, admin.path) ? stage : path };
      } catch {
        return { state: "kept", path: stage && bound(stage, identity, admin.path) ? stage : path };
      }
    },
  };
}
