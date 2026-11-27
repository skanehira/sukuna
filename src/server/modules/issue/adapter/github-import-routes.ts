import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { issues, projects } from "../../../../shared/db/schema";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { Logger } from "../../../../shared/log";
import {
  importGithubIssues,
  listGithubIssues,
  type GithubImportDependencies,
  type GithubImportError,
} from "../usecase/github-import";
import { createIssueDataRepository, type IssueQueryDatabase } from "./issue-repository";
import { createGithubIssuePort } from "./gh-cli";
import { createGitCli, createProjectGit } from "../../workspace/adapter/git-cli";

type Options = {
  changed: GithubImportDependencies["changed"];
  log: Logger;
  now?: () => number;
  id?: () => string;
};
type RoutesDependencies = GithubImportDependencies & { log: Logger };

function reader(db: IssueQueryDatabase) {
  return {
    project: (id: string) =>
      db
        .select({
          path: projects.path,
          usesGithub: projects.usesGithub,
          confirmBeforeMergeDefault: projects.confirmBeforeMergeDefault,
        })
        .from(projects)
        .where(and(eq(projects.id, id), isNull(projects.removedAt)))
        .get(),
    importedNumbers: (id: string) =>
      db
        .select({ number: issues.githubNumber })
        .from(issues)
        .where(and(eq(issues.projectId, id), isNotNull(issues.githubNumber)))
        .all()
        .flatMap(({ number }) => (number === null ? [] : [number])),
  };
}

export function createGithubImportDependencies(
  database: () => OpenedDatabase["db"],
  gh: GhRunner,
  options: Options,
): RoutesDependencies {
  return {
    get read() {
      return reader(database());
    },
    commit: (write) =>
      database().transaction(
        (db) => {
          const repository = createIssueDataRepository(db);
          return write({
            ...reader(db),
            nextNumber: (projectId) => repository.nextNumber(projectId),
            insert: (issue) => repository.insert(issue, []),
          });
        },
        { behavior: "immediate" },
      ),
    github: createGithubIssuePort(gh, createProjectGit(createGitCli())),
    clock: { now: options.now ?? Date.now, id: options.id ?? ulid },
    changed: options.changed,
    log: options.log,
  };
}

export function createGithubImportRoutes(deps: RoutesDependencies) {
  const app = new Hono();
  const status = {
    invalid_input: 400,
    not_found: 404,
    conflict: 409,
    github_unavailable: 502,
  } as const;
  const respond = <T>(c: Context, result: Result<T, GithubImportError>) =>
    result.isOk()
      ? c.json(result.value)
      : c.json({ error: result.error }, status[result.error.code]);

  app.get("/projects/:id/github-issues", async (c) =>
    respond(c, await listGithubIssues(deps, c.req.param("id"))),
  );
  app.post("/projects/:id/github-import", async (c) =>
    respond(
      c,
      await importGithubIssues(deps, c.req.param("id"), await c.req.json().catch(() => undefined)),
    ),
  );

  app.onError((error, c) => {
    deps.log({
      level: "error",
      component: "server.api",
      message: "GitHub の issue を取り込めませんでした。",
      error,
    });
    return c.json(
      {
        error: {
          code: "internal",
          message: "GitHub の issue を取り込めませんでした。もう一度操作してください。",
        },
      },
      500,
    );
  });
  return app;
}
