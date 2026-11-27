import { spawn } from "node:child_process";
import { copyFile, lstat, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { DesignGitEntry } from "../../flow/domain/design-ports";
import type { GitRunner } from "./git-cli";

const changed = {
  message:
    "既定ブランチの先端か作業場所が変わりました。状態を確認してから、もう一度承認してください",
};

export async function guardGitFile(path: string) {
  const lock = `${path}.lock`;
  const handle = await open(lock, "wx").catch(() => null);
  if (!handle) return null;
  return async () => {
    try {
      const initial = await handle.stat({ bigint: true });
      const latest = await lstat(lock, { bigint: true }).catch(() => null);
      if (latest?.dev === initial.dev && latest.ino === initial.ino) await rm(lock);
    } finally {
      await handle.close();
    }
  };
}

export async function startRefUpdate(cwd: string, ref: string, oldHead: string, commit?: string) {
  if (!/^refs\/heads\/[^\s]+$/.test(ref)) return null;
  const child = spawn("git", ["update-ref", "--stdin"], { cwd, stdio: "pipe" });
  let output = "";
  child.stdin.on("error", () => {});
  child.stderr.resume();
  let prepared: (value: boolean) => void;
  const ready = new Promise<boolean>((resolveReady) => {
    prepared = resolveReady;
  });
  const closed = new Promise<number | null>((resolveExit) => {
    child.once("close", (exit) => {
      prepared(false);
      resolveExit(exit);
    });
    child.once("error", () => {
      prepared(false);
      resolveExit(null);
    });
  });
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    output += text;
    if (output.includes("prepare: ok\n")) prepared(true);
  });
  const command =
    commit === undefined ? `verify ${ref} ${oldHead}` : `update ${ref} ${commit} ${oldHead}`;
  child.stdin.write(`start\n${command}\nprepare\n`);
  if (!(await ready)) return null;
  return {
    async finish(commitRef: boolean) {
      if (child.stdin.writable) child.stdin.end(commitRef ? "commit\n" : "abort\n");
      return (await closed) === 0;
    },
  };
}

type EntryList = (cwd: string) => Promise<Result<DesignGitEntry[], { message: string }>>;

export async function updateLocalDesign(
  git: GitRunner,
  list: EntryList,
  configuration: {
    root: string;
    fromWorktree: string;
    ref: string;
    branch: string;
    expectedCheckout: DesignGitEntry;
    oldHead: string;
    commit: string;
  },
): Promise<Result<string, { message: string }>> {
  const { root, ref, branch, expectedCheckout, oldHead, commit, fromWorktree } = configuration;
  const cwd = expectedCheckout.path;
  const acquire = async (file: string) => {
    const path = await git.run(["rev-parse", "--git-path", file], { cwd });
    return path.exitCode === 0 ? resolve(cwd, path.stdout.trim()) : null;
  };
  const matchesCheckout = async () => {
    const current = await list(root);
    if (current.isErr()) return false;
    const checkouts = current.value.filter((entry) => entry.branch === branch);
    return checkouts.length === 1 && checkouts[0]?.path === cwd && checkouts[0].head === oldHead;
  };

  const head = await acquire("HEAD");
  const index = await acquire("index");
  if (!head || !index) return err(changed);
  const unlockHead = await guardGitFile(head);
  if (!unlockHead) return err(changed);
  try {
    const unlockIndex = await guardGitFile(index);
    if (!unlockIndex) return err(changed);
    try {
      if (
        (await acquire("HEAD")) !== head ||
        (await acquire("index")) !== index ||
        !(await matchesCheckout())
      )
        return err(changed);
      const transaction = await startRefUpdate(fromWorktree, ref, oldHead, commit);
      if (!transaction) return err(changed);
      const pendingIndex = `${index}.sukuna-${randomUUID()}`;
      const stage = (from: string, to: string) =>
        git.run(["read-tree", "-u", "-m", from, to], {
          cwd,
          env: { GIT_INDEX_FILE: pendingIndex },
        });
      let temporaryIndexInstalled = false;
      let filesUpdated = false;
      let committed = false;
      try {
        if (!(await matchesCheckout())) return err(changed);
        await copyFile(index, pendingIndex);
        const update = await stage(oldHead, commit);
        if (update.exitCode !== 0)
          return err({
            message: /not uptodate|local changes|untracked|would be overwritten/i.test(
              update.stderr,
            )
              ? "プロジェクトのディレクトリに、設計書と同じファイルの未コミットの変更があります。片付けてから、もう一度承認してください"
              : `既定ブランチを更新できませんでした: ${update.stderr.trim().split("\n")[0] || "git read-tree が失敗しました"}`,
          });
        filesUpdated = true;
        await rename(pendingIndex, index);
        temporaryIndexInstalled = true;
        committed = await transaction.finish(true);
        return committed ? ok(commit) : err(changed);
      } finally {
        await transaction.finish(false);
        try {
          if (filesUpdated && !committed) {
            if (temporaryIndexInstalled) await copyFile(index, pendingIndex);
            const restored = await stage(commit, oldHead);
            if (restored.exitCode === 0 && temporaryIndexInstalled)
              await rename(pendingIndex, index);
          }
        } finally {
          await rm(pendingIndex, { force: true });
        }
      }
    } finally {
      await unlockIndex();
    }
  } finally {
    await unlockHead();
  }
}
