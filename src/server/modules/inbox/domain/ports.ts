import type { Result } from "neverthrow";
import type { IssueState, IssueStopReason } from "../../../../shared/issue/state";
import type { ProgressEvent } from "../../conversation/domain/progress-port";
export type InboxConversation = {
  id: string;
  projectId: string;
  kind: string;
  issueId: string | null;
  parentConversationId: string | null;
  title: string | null;
  cwd: string;
  runState: string;
  stopReason: string | null;
  resetsAt: number | null;
  lastSeq: number;
  lastReadSeq: number;
  recapSeq: number;
  recapFailedAt: number | null;
  lastActivityAt: number | null;
  closedAt: number | null;
  events: ProgressEvent[];
  questions: string[];
};
export type InboxIssue = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  state: IssueState;
  stopReason: IssueStopReason | null;
  parentId: string | null;
  priority: "high" | "medium" | "low" | null;
  createdAt: number;
  closedAt: number | null;
  events: ProgressEvent[];
};
export type InboxProject = {
  id: string;
  name: string;
  flowPaused: boolean;
  autoStages: ("triage" | "design" | "impl")[];
  conversations: InboxConversation[];
  issues: InboxIssue[];
  dependencies: { issueId: string; dependsOnId: string }[];
  worktrees: { id: string; path: string; removedAt: number | null }[];
};
export type InboxSnapshot = { projects: InboxProject[]; flowPaused: boolean };
export type InboxError = { code: "not_found" | "internal"; message: string };
export interface InboxRepositoryPort {
  load(projectId?: string): Result<InboxSnapshot, InboxError>;
}
export type InboxDependencies = { repository: InboxRepositoryPort; resetTime(at: number): string };
