import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { err, ok } from "neverthrow";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createGhRunner, type GhRunner } from "../../../../shared/gh/gh-runner";
import { projectStopResponseSchema } from "../../../../shared/ipc";
import { reserveProjectActivity } from "../../../../shared/project/sqlite-project-run-activity";
import { runnerUnavailable } from "../../../runner-link";
import { createProjectGithub } from "../../issue/adapter/gh-cli";
import type { DirectoryEntry, DirectoryListing } from "../domain/path-candidates";
import type { ProjectDependencies } from "../domain/project-settings";
import { createGitCli, createProjectGit, type GitRunner } from "./git-cli";
import { createProjectRepository } from "./project-repository";

type DirectoryReader = {
  readdir(path: string): Promise<Dirent[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};
const nodeDirectories: DirectoryReader = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  stat,
};
const directoryReadLimitMs = 3000;

async function listDirectory(
  reader: DirectoryReader,
  path: string,
  accept: (name: string) => boolean,
): Promise<DirectoryListing> {
  let dirents: Dirent[];
  try {
    dirents = await reader.readdir(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
  const isDirectory = (target: string) =>
    reader.stat(target).then(
      (info) => info.isDirectory(),
      () => false,
    );
  const entries = await Promise.all(
    dirents
      .filter((dirent) => accept(dirent.name))
      .map(async (dirent): Promise<DirectoryEntry[]> => {
        const target = join(path, dirent.name);
        if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && (await isDirectory(target))))
          return [];
        return [{ name: dirent.name, repository: await isDirectory(join(target, ".git")) }];
      }),
  );
  return { kind: "listed", entries: entries.flat() };
}

type Options = {
  runner(): { forward(method: string, path: string, input?: unknown): Promise<Response> };
  changed(projectId: string): void;
  notifications?: ProjectDependencies["notifications"];
  git?: GitRunner;
  gh?: GhRunner;
  home?: string;
  directories?: DirectoryReader;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  id?: () => string;
};
export function createProjectDependencies(
  database: () => OpenedDatabase,
  options: Options,
): ProjectDependencies {
  const home = options.home ?? homedir();
  const expandHome = (input: string) =>
    input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  const directories = options.directories ?? nodeDirectories;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
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
      const path = expandHome(input);
      try {
        return ok(await realpath(path));
      } catch {
        return err({ code: "invalid_input", message: `パスがありません: ${path}` });
      }
    },
    async readDirectory(directory, accept) {
      const abort = new AbortController();
      const timedOut = wait(directoryReadLimitMs, abort.signal).then(
        (): DirectoryListing => ({ kind: "unreadable" }),
        (): DirectoryListing => ({ kind: "unreadable" }),
      );
      try {
        return await Promise.race([
          listDirectory(directories, expandHome(directory), accept),
          timedOut,
        ]);
      } finally {
        abort.abort();
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
    notifications: options.notifications,
    async changed(id) {
      options.changed(id);
      await options
        .runner()
        .forward("POST", "/flow/notify", { project_id: id })
        .catch(() => {});
    },
  };
}
