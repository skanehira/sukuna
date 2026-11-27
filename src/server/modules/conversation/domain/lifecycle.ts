import type { Result } from "neverthrow";
import { closeWhileWorkingMessage } from "../../../../shared/lifecycle";
import type { RunState } from "../../../../shared/events";
import type {
  ClosingIssue,
  ClosingSummary,
  ListedConversation,
  SearchResult,
} from "../../../../shared/lifecycle";

export const lifecycleMissing = { code: "not_found" as const, message: "会話が見つかりません。" };
export const lifecycleConflict = {
  code: "conflict" as const,
  message: "会話の状態が変わりました。読み直してから操作してください。",
};
export const closingConflict = {
  code: "conflict" as const,
  message: "締めくくれるのは会話です。",
};
export const workingConflict = {
  code: "conflict" as const,
  message: closeWhileWorkingMessage,
};
export const deletionConflict = {
  code: "conflict" as const,
  message: "issue の会話は削除できません。issue を取り下げてください",
};

export function isWorking(state: RunState): boolean {
  return state === "working" || state === "waiting_answer" || state === "waiting_permission";
}

export type ConversationRecord = ListedConversation & {
  kind: string;
  projectId: string;
  cwd: string;
  issueId: string | null;
  parentId: string | null;
};
export type ClosingSource = {
  conversation: ConversationRecord;
  firstEventAt: number | null;
  createdIssues: ClosingIssue[];
  stock: ClosingSummary["remaining"]["stock"];
  project: { defaultBranch: string; usesGithub: boolean };
};

type NonGitOutputs = Pick<ClosingSummary["outputs"], "issues" | "files">;
type NonGitRemaining = Pick<ClosingSummary["remaining"], "stock" | "runningThreads">;
export type ClosingGitSummary = {
  git: boolean;
  outputs: Omit<ClosingSummary["outputs"], keyof NonGitOutputs>;
  remaining: Omit<ClosingSummary["remaining"], keyof NonGitRemaining>;
};
export type Reservation = { id: string; token: string; complete(): Promise<void> };
export type LifecycleError = {
  code: "not_found" | "conflict" | "runner_unavailable" | "internal";
  message: string;
};

export interface LifecycleRepository {
  conversation(id: string): ConversationRecord | undefined;
  threads(id: string): ConversationRecord[];
  summary(id: string): ClosingSource | undefined;
  project(id: string): { conversations: ConversationRecord[]; issues: ClosingIssue[] } | undefined;
  search(query: string, limit: number): SearchResult[];
  transaction<T>(run: () => T): T;
  activeReservations(reservations: Reservation[]): boolean;
  close(id: string, at: number, conversationIds: string[]): void;
  pendingWithdrawal(id: string, at: number): string[] | undefined;
  completeWithdrawal(id: string, at: number): void;
  delete(ids: string[]): void;
}

export type WithdrawalTarget =
  | { kind: "conversations"; ids: string[] }
  | { kind: "notifications"; ids: string[] };

export interface LifecycleDependencies {
  repository: LifecycleRepository;
  git(
    cwd: string,
    project: ClosingSource["project"],
    firstEventAt: number | null,
  ): Promise<ClosingGitSummary>;
  changedFiles(id: string): Promise<Result<string[], { message: string }>>;
  reserve(id: string, onlyIdle: boolean): Promise<Result<Reservation, LifecycleError>>;
  withdraw(target: WithdrawalTarget): Promise<void>;
  removeImages(id: string): Promise<void>;
  changed(projectId: string, conversationIds: string[], parentId?: string): void;
  logWithdrawalFailure(id: string, error: unknown): void;
  now(): number;
  serial<T>(id: string, run: () => Promise<T>): Promise<T>;
}
