import { err, ok, type Result } from "neverthrow";
import type { PathCandidates } from "../../../../shared/api/project";
import type { ProjectError } from "./project-settings";

export type PathQuery = { directory: string; prefix: string };
export type DirectoryEntry = { name: string; repository: boolean };
export type DirectoryListing =
  | { kind: "listed"; entries: DirectoryEntry[] }
  | { kind: "missing" }
  | { kind: "unreadable" };

const pathCandidateLimit = 200;
const pathFormError: ProjectError = {
  code: "invalid_input",
  message: "パスは / または ~/ で始まる形で指定してください。",
};
const pathLineError: ProjectError = {
  code: "invalid_input",
  message: "パスに改行と NUL は書けません。",
};

export function parsePathQuery(text: string): Result<PathQuery, ProjectError> {
  if (/[\0\n\r]/.test(text)) return err(pathLineError);
  const normalized = text === "" || text === "~" ? "~/" : text;
  if (!normalized.startsWith("/") && !normalized.startsWith("~/")) return err(pathFormError);
  const split = normalized.lastIndexOf("/") + 1;
  return ok({ directory: normalized.slice(0, split), prefix: normalized.slice(split) });
}

export function matchesPathPrefix(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && (!name.startsWith(".") || prefix.startsWith("."));
}

const byCodeUnit = (a: DirectoryEntry, b: DirectoryEntry) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function pathCandidates(query: PathQuery, listing: DirectoryListing): PathCandidates {
  if (listing.kind !== "listed")
    return {
      candidates: [],
      truncated: false,
      note:
        listing.kind === "missing"
          ? `ディレクトリがありません: ${query.directory}`
          : `ディレクトリを読めません: ${query.directory}`,
    };
  const matched = listing.entries
    .filter((entry) => matchesPathPrefix(entry.name, query.prefix))
    .toSorted(byCodeUnit);
  return {
    candidates: matched.slice(0, pathCandidateLimit).map(({ name, repository }) => ({
      name,
      text: `${query.directory}${name}/`,
      repository,
    })),
    truncated: matched.length > pathCandidateLimit,
    note: matched.length === 0 ? "一致するディレクトリはありません" : null,
  };
}
