import { err } from "neverthrow";
import { issueToolSchemas, type IssueToolName } from "../../../../shared/issue/schema";
import type { AppToolRegistry } from "../../conversation/usecase/app-tool-registry";
import type { ConversationKind } from "../../conversation/domain/conversation-store";
import type { IssueToolDeps } from "../domain/ports";
import { createToolHandlers } from "../usecase/tool-handlers";

const common: IssueToolName[] = ["issue_get", "issue_list"];
const writing: IssueToolName[] = ["issue_create", "issue_update", "issue_comment"];
export const issueToolsByKind: Record<ConversationKind, IssueToolName[]> = {
  chat: [...common, ...writing],
  thread: [...common, ...writing],
  triage: [...common, "issue_update", "issue_comment", "report_triage", "report_needs_human"],
  design: [...common, ...writing, "report_design", "report_needs_human"],
  impl: [
    ...common,
    ...writing,
    "report_stage",
    "report_ready_for_merge",
    "report_ci_failed",
    "report_implementation_done",
    "report_needs_human",
  ],
};
export const unavailableIssueReports: IssueToolDeps["reports"] = {
  report: async () =>
    err({
      code: "conflict",
      message: "この報告の処理はまだ利用できません。会話に結果を残してください。",
    }),
};
export function registerIssueTools(registry: AppToolRegistry, deps: IssueToolDeps): void {
  const handler = createToolHandlers(deps);
  for (const name of Object.keys(issueToolSchemas) as IssueToolName[])
    registry.register(
      {
        name,
        description: `sukuna の issue を扱います: ${name}`,
        input: issueToolSchemas[name].shape,
        alwaysLoad: true,
        handler: (input, context) => handler(name, input, context),
      },
      (Object.keys(issueToolsByKind) as ConversationKind[]).filter((kind) =>
        issueToolsByKind[kind].includes(name),
      ),
    );
}
