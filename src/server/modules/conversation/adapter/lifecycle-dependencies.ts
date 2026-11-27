import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok } from "neverthrow";
import { z } from "zod";
import type { OpenedDatabase } from "../../../../shared/db/open";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { releaseReservationSchema } from "../../../../shared/ipc";
import type { Logger } from "../../../../shared/log";
import { runnerUnavailable, type RunnerLink } from "../../../runner-link";
import { createClosingGitCli, createGitCli, type GitRunner } from "../../workspace/adapter/git-cli";
import type { WorkspaceDependencies } from "../../workspace/domain/ports";
import { listChanges } from "../../workspace/usecase/list-changes";
import {
  lifecycleConflict,
  lifecycleMissing,
  type LifecycleDependencies,
} from "../domain/lifecycle";
import { createLifecycleRepository } from "./lifecycle-repository";

const ipcError = z.object({ error: z.object({ message: z.string() }) });

export function createLifecycleDependencies(options: {
  database: () => OpenedDatabase;
  home: string;
  runner: Pick<RunnerLink, "forward">;
  workspace: WorkspaceDependencies;
  gh: GhRunner;
  git?: GitRunner;
  gitDeadline?: () => AbortSignal;
  log: Logger;
  now: LifecycleDependencies["now"];
  withdraw: LifecycleDependencies["withdraw"];
  changed: LifecycleDependencies["changed"];
}): LifecycleDependencies {
  const running = new Map<string, Promise<unknown>>();
  return {
    repository: createLifecycleRepository(options.database),
    git: createClosingGitCli(options.git ?? createGitCli(), options.gh, options.gitDeadline),
    changedFiles: async (id) =>
      (await listChanges(id, options.workspace)).map(({ files }) => files.map(({ path }) => path)),
    async reserve(id, onlyIdle) {
      const path = `/conversations/${encodeURIComponent(id)}/release`;
      const response = await options.runner.forward("POST", path + "/reserve", {
        only_idle: onlyIdle,
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 503) return err(runnerUnavailable);
        if (response.status === 404) return err(lifecycleMissing);
        const parsed = ipcError.safeParse(data);
        if (response.status === 409)
          return err({
            ...lifecycleConflict,
            message: parsed.success ? parsed.data.error.message : lifecycleConflict.message,
          });
        return err({
          code: "internal",
          message: "会話の実行を手放せませんでした。もう一度操作してください。",
        });
      }
      const reservation = releaseReservationSchema.safeParse(data);
      if (!reservation.success) return err(runnerUnavailable);
      const { token } = reservation.data;
      return ok({
        id,
        token,
        complete: async () => {
          await options.runner.forward("POST", path + "/complete", { token });
        },
      });
    },
    async removeImages(id) {
      try {
        if (!id || id === "." || id === ".." || /[\\/]/.test(id))
          throw new Error("画像の保存先が正しくありません");
        const directory = join(options.home, "images");
        const entry = await lstat(directory);
        if (
          !entry.isDirectory() ||
          (await realpath(directory)) !== resolve(await realpath(options.home), "images")
        )
          throw new Error("画像の保存先が正しくありません");
        await rm(join(directory, id), { recursive: true, force: true });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        options.log({
          level: "error",
          component: "server.conversation",
          conversation_id: id,
          message: "会話の画像を削除できませんでした。",
          error,
        });
      }
    },
    withdraw: options.withdraw,
    logWithdrawalFailure: (id, error) =>
      options.log({
        level: "error",
        component: "server.conversation",
        conversation_id: id,
        message: "閉じた会話の通知を取り下げられませんでした。",
        error,
      }),
    changed: options.changed,
    now: options.now,
    async serial(id, run) {
      const previous = running.get(id);
      const task = (previous ?? Promise.resolve()).then(run, run);
      running.set(id, task);
      try {
        return await task;
      } finally {
        if (running.get(id) === task) running.delete(id);
      }
    },
  };
}
