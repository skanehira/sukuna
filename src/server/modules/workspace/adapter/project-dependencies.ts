import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createGhRunner, type GhRunner } from "../../../../shared/gh/gh-runner";
import { projectStopResponseSchema } from "../../../../shared/ipc";
import { reserveProjectActivity } from "../../../../shared/project/sqlite-project-run-activity";
import { runnerUnavailable } from "../../../runner-link";
import { createProjectGithub } from "../../issue/adapter/gh-cli";
import type { ProjectDependencies } from "../domain/project-settings";
import { createGitCli, createProjectGit, type GitRunner } from "./git-cli";
import { createProjectRepository } from "./project-repository";

type Options = {
  runner(): { forward(method: string, path: string, input?: unknown): Promise<Response> };
  changed(projectId: string): void;
  git?: GitRunner;
  gh?: GhRunner;
  home?: string;
  now?: () => number;
  id?: () => string;
};
export function createProjectDependencies(
  database: () => OpenedDatabase,
  options: Options,
): ProjectDependencies {
  const home = options.home ?? homedir();
  return {
    repository: createProjectRepository(database),
    transaction: (operation) => database().sqlite.transaction(operation).immediate(),
    resolvePath: async (input) => {
      if (
        !(input.startsWith("/") || input === "~" || input.startsWith("~/")) ||
        input.includes("\0")
      )
        return err({
          code: "invalid_input",
          message: "パスは / または ~/ で始まる形で指定してください。",
        });
      const path =
        input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
      try {
        return ok(await realpath(path));
      } catch {
        return err({ code: "invalid_input", message: `パスがありません: ${path}` });
      }
    },
    git: createProjectGit(options.git ?? createGitCli()),
    github: createProjectGithub(options.gh ?? createGhRunner(process.env.SUKUNA_GH ?? null)),
    id: options.id ?? ulid,
    now: options.now ?? (() => Date.now()),
    reserve: (id) => reserveProjectActivity(database().sqlite.name, id, "remove"),
    async stop(id) {
      const response = await options
        .runner()
        .forward("POST", `/flow/projects/${encodeURIComponent(id)}/stop`);
      if (response.status === 503) return err(runnerUnavailable);
      const parsed = projectStopResponseSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      return response.ok && parsed.success
        ? ok(parsed.data.stopped_conversation_ids)
        : err({
            code: "internal",
            message: "プロジェクトの会話を停止できませんでした。もう一度操作してください。",
          });
    },
    async changed(id) {
      options.changed(id);
      await options
        .runner()
        .forward("POST", "/flow/notify", { project_id: id })
        .catch(() => {});
    },
  };
}
