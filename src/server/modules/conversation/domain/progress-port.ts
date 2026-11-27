import type { Result } from "neverthrow";
import type { ActivityEvent } from "../../../../shared/activity/stage";
import type { TimelineFilePort } from "./timeline/file-port";

export type ProgressEvent = ActivityEvent & { seq: number };
export type ProgressConversation = {
  id: string;
  kind: string;
  sessionId: string | null;
  cwd: string;
  runState: string;
};
export type ProgressIssue = { id: string; state: string };
export type ProgressError = { code: "not_found" | "internal"; message: string };
export interface ProgressRepositoryPort {
  findConversation(id: string): Result<ProgressConversation | null, ProgressError>;
  findIssue(id: string): Result<ProgressIssue | null, ProgressError>;
  listIssueConversations(issueId: string): Result<ProgressConversation[], ProgressError>;
  conversationEvents(id: string): Result<ProgressEvent[], ProgressError>;
  issueEvents(id: string): Result<ProgressEvent[], ProgressError>;
}
export type ProgressDependencies = {
  repository: ProgressRepositoryPort;
  timeline: TimelineFilePort;
};
