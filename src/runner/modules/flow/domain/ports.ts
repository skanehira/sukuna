import type { IssueState, IssueStopReason, StateChanged } from "../../../../shared/issue/state";
import type { TransitionContext } from "./transition";

export type FlowIssue = {
  id: string;
  projectId: string;
  number: number;
  state: IssueState;
  stopReason: IssueStopReason | null;
  designed: boolean;
  confirmBeforeMerge: boolean;
};

export type IssueNotice = { kind: "issue"; issue_id: string; project_id: string; seq: number };

export interface IssueRepositoryPort {
  getIssue(id: string): FlowIssue | undefined;
  contextOf(issue: FlowIssue): TransitionContext;
  saveStateChange(issue: FlowIssue, change: StateChanged, now: number): IssueNotice | null;
  dependentIssueIds(id: string): string[];
  withdrawnDependencies(id: string): { number: number }[];
  workingStageConversationIds(id: string): string[];
}

export interface IssueUnitOfWorkPort {
  run<T>(action: (repository: IssueRepositoryPort) => T): T;
}

export interface IssueNoticePort {
  publish(notice: IssueNotice): void;
}

export interface ClockPort {
  now(): number;
}

export interface StopConversationPort {
  stop(conversationId: string): Promise<void>;
}
