import type { Result } from "neverthrow";
import type { DesignError } from "../../../../shared/api/design";
import type { IssueDataRepository, IssueEvent } from "../../../../shared/issue/ports";
import type { IssueRecord } from "../../../../shared/issue/schema";
import type { WorktreeActivityReservation } from "../../../../shared/workspace/worktree-activity";
import type { DesignProject } from "../../../../shared/design/records";
import type { DesignWorktree, DesignWorkspaceRequest } from "./design-ports";
import type { IssueRepositoryPort } from "./ports";
import type { TransitionContext } from "./transition";

export type StageProject = DesignProject & {
  name: string;
  removedAt: number | null;
  implConcurrency: number;
};
export type StageSnapshot = {
  issue: IssueRecord;
  project: StageProject;
  events: IssueEvent[];
  context: TransitionContext;
};
export interface StageRepository {
  data: IssueDataRepository;
  now(): number;
  project(id: string): StageProject | undefined;
  globallyPaused(): boolean;
  read(id: string): StageSnapshot | undefined;
  events(id: string): IssueEvent[];
  projects(): { id: string }[];
  issues(id: string): { id: string }[];
  transaction<T>(
    action: (flow: IssueRepositoryPort, data: IssueDataRepository) => T,
    lease?: WorktreeActivityReservation,
  ): T;
  append(issueId: string, type: string, payload: unknown): IssueEvent;
}
export interface StageDesign {
  workspace(input: DesignWorkspaceRequest): Promise<Result<DesignWorktree, DesignError>>;
  attachWorkspace(
    issueId: string,
    conversationId: string,
    tree: DesignWorktree,
    reservation: WorktreeActivityReservation,
  ): Result<DesignWorktree, DesignError>;
  submit(
    id: string,
    conversationId: string,
    input: { policy: string; checks: string[] },
  ): Promise<Result<void, DesignError>>;
  sendPrInstruction(id: string, url: string): Promise<Result<void, DesignError>>;
  completePr(id: string, lastAssistantText: string): Promise<Result<void, DesignError>>;
  recoverApproval(id: string): Promise<void>;
  drain(): Promise<unknown>;
}
