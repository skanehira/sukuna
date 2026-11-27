import { err, ok, type Result } from "neverthrow";
import {
  githubImportInputSchema,
  type GithubImportResponse,
  type GithubIssueCandidate,
  type GithubIssuesResponse,
} from "../../../../shared/api/github-import";
import { newIssue, validateIssueInput } from "../../../../shared/issue/rules";
import type { IssueClock } from "../../../../shared/issue/ports";
import type { IssueRecord } from "../../../../shared/issue/schema";

type GithubFailure = { code: "github_unavailable"; message: string };
export type GithubImportError =
  | GithubFailure
  | {
      code: "invalid_input" | "not_found" | "conflict";
      message: string;
    };
export type RemoteIssue = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
};
export type GithubIssueTarget = { cwd: string; repository: string };
export interface GithubIssuePort {
  resolve(cwd: string): Promise<Result<GithubIssueTarget, GithubFailure>>;
  list(target: GithubIssueTarget): Promise<Result<GithubIssueCandidate[], GithubFailure>>;
  get(
    target: GithubIssueTarget,
    number: number,
  ): Promise<Result<RemoteIssue | null, GithubFailure>>;
}
export const githubIssueLimit = 200;

type Project = { path: string; usesGithub: boolean; confirmBeforeMergeDefault: boolean };
interface ImportReader {
  project(id: string): Project | undefined;
  importedNumbers(id: string): number[];
}
interface ImportWriter extends ImportReader {
  nextNumber(projectId: string): number;
  insert(issue: IssueRecord): void;
}
export interface GithubImportDependencies {
  read: ImportReader;
  commit<T>(write: (repository: ImportWriter) => T): T;
  github: GithubIssuePort;
  clock: IssueClock;
  changed(issueId: string, projectId: string): void;
}

function githubProject(reader: ImportReader, id: string): Result<Project, GithubImportError> {
  const project = reader.project(id);
  if (!project) return err({ code: "not_found", message: "プロジェクトが見つかりません。" });
  if (!project.usesGithub)
    return err({ code: "conflict", message: "このプロジェクトは GitHub を使いません。" });
  return ok(project);
}

export async function listGithubIssues(
  deps: GithubImportDependencies,
  projectId: string,
): Promise<Result<GithubIssuesResponse, GithubImportError>> {
  const project = githubProject(deps.read, projectId);
  if (project.isErr()) return err(project.error);
  const target = await deps.github.resolve(project.value.path);
  if (target.isErr()) return err(target.error);
  const candidates = await deps.github.list(target.value);
  if (candidates.isErr()) return err(candidates.error);
  const current = githubProject(deps.read, projectId);
  if (current.isErr()) return err(current.error);
  const imported = new Set(deps.read.importedNumbers(projectId));
  return ok({
    issues: candidates.value
      .toSorted((a, b) => b.number - a.number)
      .slice(0, githubIssueLimit)
      .map((row) => ({ ...row, imported: imported.has(row.number) })),
    truncated: candidates.value.length >= githubIssueLimit,
  });
}

export async function importGithubIssues(
  deps: GithubImportDependencies,
  projectId: string,
  input: unknown,
): Promise<Result<GithubImportResponse, GithubImportError>> {
  const request = githubImportInputSchema.safeParse(input);
  if (!request.success)
    return err({
      code: "invalid_input",
      message: "取り込む issue の番号を 1〜100 件指定してください。",
    });

  const project = githubProject(deps.read, projectId);
  if (project.isErr()) return err(project.error);
  const already = new Set(deps.read.importedNumbers(projectId));
  const fetched = new Map<number, Result<RemoteIssue | null, GithubFailure>>();
  const pending = request.data.numbers.filter((number) => !already.has(number));
  if (pending.length > 0) {
    const target = await deps.github.resolve(project.value.path);
    if (target.isErr()) return err(target.error);
    for (const number of pending) fetched.set(number, await deps.github.get(target.value, number));
  }
  const fetchedAnyIssue = [...fetched.values()].some(
    (response) => response.isOk() && response.value !== null,
  );

  const result = deps.commit((repository): Result<GithubImportResponse, GithubImportError> => {
    const current = githubProject(repository, projectId);
    if (current.isErr()) return err(current.error);
    if (current.value.path !== project.value.path)
      return err({
        code: "conflict",
        message: "プロジェクトの状態が変わりました。読み直してください。",
      });

    const used = new Set(repository.importedNumbers(projectId));
    const imported: GithubImportResponse["imported"] = [];
    const skipped: GithubImportResponse["skipped"] = [];
    let firstFailure: GithubFailure | undefined;
    for (const number of request.data.numbers) {
      const response = fetched.get(number);
      if (response === undefined || used.has(number)) {
        skipped.push({ githubNumber: number, reason: "already_imported" });
        continue;
      }

      if (response.isErr()) {
        firstFailure ??= response.error;
        skipped.push({ githubNumber: number, reason: "not_found" });
        continue;
      }

      const remote = response.value;
      if (!remote) {
        skipped.push({ githubNumber: number, reason: "not_found" });
        continue;
      }
      if (remote.state !== "OPEN") {
        skipped.push({ githubNumber: number, reason: "not_open" });
        continue;
      }

      const body = [remote.body.trim(), `GitHub から取り込んだ issue: ${remote.url}`]
        .filter(Boolean)
        .join("\n\n");
      const text = validateIssueInput({ title: remote.title, body });
      if (!text) {
        skipped.push({ githubNumber: number, reason: "too_long" });
        continue;
      }
      const issue = {
        ...newIssue(
          deps.clock.id(),
          projectId,
          repository.nextNumber(projectId),
          deps.clock.now(),
          current.value.confirmBeforeMergeDefault,
        ),
        title: text.title ?? "",
        body: text.body ?? "",
        githubNumber: number,
      };
      repository.insert(issue);
      imported.push({ githubNumber: number, issueId: issue.id, issueNumber: issue.number });
    }

    return firstFailure && !fetchedAnyIssue ? err(firstFailure) : ok({ imported, skipped });
  });

  if (result.isOk())
    for (const issue of result.value.imported) deps.changed(issue.issueId, projectId);
  return result;
}
