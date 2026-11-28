import type { Result } from "neverthrow";
import type { IssueInput, IssueListInput, IssueRecord, IssueSummary, IssueView } from "./schema";
import type { IssueLinks, IssueRuleError } from "./rules";
import type { Logger } from "../log";

export type IssueError =
  | IssueRuleError
  | {
      code:
        | "not_found"
        | "conflict"
        | "confirmed_text_locked"
        | "title_required"
        | "runner_unavailable"
        | "internal";
      message: string;
    };
export const issueNotFound: IssueError = {
  code: "not_found",
  message: "issue またはプロジェクトが見つかりません。読み直してください。",
};
export const issueConflict: IssueError = {
  code: "conflict",
  message: "issue の状態が変わりました。読み直してから操作してください。",
};
export type IssueEvent = {
  issueId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
};
export type ToolContext = { conversationId: string; projectId: string; issueId: string | null };
export type IssueConversation = {
  id: string;
  projectId: string;
  issueId: string | null;
  kind: "chat" | "thread" | "triage" | "design" | "impl";
};
export interface IssueDataRepository {
  project(id: string): { id: string; confirmBeforeMergeDefault: boolean } | undefined;
  get(id: string): IssueRecord | undefined;
  byNumber(projectId: string, number: number): IssueRecord | undefined;
  all(projectId: string): IssueRecord[];
  graph(projectId: string): IssueLinks[];
  nextNumber(projectId: string): number;
  view(id: string, includePageDetails?: boolean): IssueView | undefined;
  list(
    projectId: string,
    input: IssueListInput,
  ): { items: IssueSummary[]; nextCursor: string | null };
  insert(issue: IssueRecord, dependencies: string[]): void;
  update(id: string, fields: Partial<IssueRecord>, dependencies?: string[]): void;
  append(id: string, type: string, payload: unknown, now: number): IssueEvent;
  conversation(id: string): IssueConversation | undefined;
  activeConversationIds(issueId: string): string[];
  designPrPending(issueId: string): boolean;
}
export interface IssueDataUnitOfWork {
  read: IssueDataRepository;
  run<T>(this: void, action: (repository: IssueDataRepository) => T): T;
  create<T>(this: void, action: (repository: IssueDataRepository) => T): T;
}
export type IssueWriteInput = IssueInput & Pick<Partial<IssueRecord>, "kind" | "designed">;
export type IssueClock = { now(): number; id(): string };
export type IssueRunnerPort = {
  forward(method: string, path: string, input?: unknown): Promise<Response>;
};
export type IssueServerDeps = {
  unitOfWork: IssueDataUnitOfWork;
  clock: IssueClock;
  runner: IssueRunnerPort;
  log: Logger;
  changed(issueId: string, projectId: string): void;
};
export type IssueOperationResult = Result<
  { issue: IssueView; stoppedDependents?: number[] },
  IssueError
>;
