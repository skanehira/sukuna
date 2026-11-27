import type { Result } from "neverthrow";
import type { z } from "zod";
import type {
  IssueDataUnitOfWork,
  IssueError,
  IssueOperationResult,
  IssueWriteInput,
  ToolContext,
} from "../../../../shared/issue/ports";
import type { issueToolSchemas, IssueToolName } from "../../../../shared/issue/schema";
export type IssueToolReply = { text: string; isError: boolean };
export type IssueReportName = Extract<IssueToolName, `report_${string}`>;
export interface IssueReportsPort {
  report(
    name: IssueReportName,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<Result<string, IssueError>>;
}
export interface IssueToolFlowPort {
  create(
    projectId: string,
    conversationId: string,
    input: z.infer<typeof issueToolSchemas.issue_create>,
  ): Result<{ number: number; duplicate: boolean }, IssueError>;
  update(id: string, input: IssueWriteInput, conversationId: string): IssueOperationResult;
  comment(id: string, conversationId: string, text: string): Result<void, IssueError>;
}
export type IssueToolDeps = {
  data: IssueDataUnitOfWork;
  flow: IssueToolFlowPort;
  reports: IssueReportsPort;
};
