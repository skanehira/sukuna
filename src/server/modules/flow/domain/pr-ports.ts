import type { Result } from "neverthrow";
import type { PrFile, PrResponse, PublishResponse } from "../../../../shared/api/pr";
import type { Quote } from "../../../../shared/stock";
import type { IssueState, IssueStopReason } from "../../../../shared/issue/state";
export type PrError = {
  code:
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "github_unavailable"
    | "runner_unavailable"
    | "internal";
  message: string;
};
export const prConflict: PrError = {
  code: "conflict",
  message: "issue の状態が変わりました。読み直してから操作してください。",
};
export type PrContext = {
  issue: {
    id: string;
    projectId: string;
    state: IssueState;
    stopReason: IssueStopReason | null;
    prUrl: string | null;
  };
  project: { path: string; usesGithub: boolean; defaultBranch: string };
  implConversationId: string | null;
  worktree: { id: string; path: string; branch: string } | null;
  earlierPrUrls: string[];
  unsentInstructionCount: number;
  stoppedFromImplementation: boolean;
};
export type PublishStock = {
  id: string;
  conversationId: string;
  kind: string;
  text: string;
  quote: Quote | null;
  githubCommentUrl: string | null;
};
export interface PrRepository {
  context(id: string): PrContext | undefined;
  snapshot(id: string, url: string): PrResponse | null;
  saveSnapshot(id: string, url: string, payload: PrResponse): void;
  stocks(ids: string[]): PublishStock[];
  markPublished(items: PublishResponse["published"]): void;
}
export type GithubPr = {
  pr: NonNullable<PrResponse["pr"]>;
  checks: PrResponse["checks"];
  evidence: PrResponse["evidence"];
  files: PrFile[];
  diffTooLarge: boolean;
};
export type ReviewComment = {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
};
export type ReviewInput = {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: ReviewComment[];
};
export interface PrGithubPort {
  read(url: string, cwd: string): Promise<Result<GithubPr, PrError>>;
  head(url: string, cwd: string): Promise<Result<{ headSha: string; state: string }, PrError>>;
  review(
    url: string,
    cwd: string,
    input: ReviewInput,
  ): Promise<
    Result<{ reviewUrl: string; commentUrls: string[] }, PrError & { lineRejected?: boolean }>
  >;
}
export type LocalPr = { branch: string; baseBranch: string; headSha: string; files: PrFile[] };
export interface PrGitPort {
  read(cwd: string, branch: string, baseBranch: string): Promise<Result<LocalPr, PrError>>;
}
export type PrDependencies = {
  repository: PrRepository;
  transaction<T>(action: (repository: PrRepository) => T): T;
  github: PrGithubPort;
  git: PrGitPort;
  runner: { forward(method: string, path: string, input?: unknown): Promise<Response> };
  now(): number;
  publishing: Set<string>;
  changed(id: string): void;
};
