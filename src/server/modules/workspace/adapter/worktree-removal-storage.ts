import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { WorktreeError, WorktreeRemovalStoragePort } from "../domain/worktree-ports";
import type { GitRunner } from "./git-cli";

const planSchema = z.object({
  branchHead: z.string().nullable(),
  worktreeRemoved: z.boolean(),
  identity: z.string().nullable(),
});
const failure = (): WorktreeError => ({
  code: "internal",
  message: "worktree の削除の記録を読み書きできませんでした",
});
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export function createWorktreeRemovalStorage(git: GitRunner): WorktreeRemovalStoragePort {
  const location = async (cwd: string, id: string) => {
    const result = await git.run(["rev-parse", "--git-common-dir"], { cwd });
    return result.exitCode === 0
      ? ok(
          join(
            resolve(cwd, result.stdout.trim()),
            "sukuna-worktree-removals",
            `${encodeURIComponent(id)}.json`,
          ),
        )
      : err(failure());
  };
  return {
    async load(project, id) {
      const file = await location(project.path, id);
      if (file.isErr()) return err(file.error);
      const contents = await ResultAsync.fromPromise(readFile(file.value, "utf8"), (error) =>
        missing(error) ? null : failure(),
      );
      if (contents.isErr()) return contents.error === null ? ok(null) : err(contents.error);
      const parsed = await ResultAsync.fromPromise(
        Promise.resolve().then((): unknown => JSON.parse(contents.value)),
        failure,
      );
      if (parsed.isErr()) return err(parsed.error);
      const plan = planSchema.safeParse(parsed.value);
      return plan.success ? ok(plan.data) : err(failure());
    },
    async save(project, id, plan) {
      const file = await location(project.path, id);
      if (file.isErr()) return err(file.error);
      return ResultAsync.fromPromise(
        (async () => {
          await mkdir(resolve(file.value, ".."), { recursive: true });
          await writeFile(`${file.value}.tmp`, JSON.stringify(plan));
          await rename(`${file.value}.tmp`, file.value);
        })(),
        failure,
      );
    },
    async clear(project, id) {
      const file = await location(project.path, id);
      return file.isErr()
        ? err(file.error)
        : ResultAsync.fromPromise(rm(file.value, { force: true }), failure);
    },
    async identity(path) {
      const result = await git.run(["rev-parse", "--absolute-git-dir"], { cwd: path });
      if (result.exitCode !== 0) return err(failure());
      const gitDir = result.stdout.trim();
      return ResultAsync.fromPromise(stat(gitDir, { bigint: true }), failure).map(
        (info) => `${gitDir}\0${info.dev}\0${info.ino}`,
      );
    },
  };
}
