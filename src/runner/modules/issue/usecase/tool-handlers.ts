import type { ToolContext, IssueWriteInput } from "../../../../shared/issue/ports";
import { issueToolSchemas, type IssueToolName } from "../../../../shared/issue/schema";
import type { IssueToolDeps, IssueToolReply, IssueReportName } from "../domain/ports";

const failure = (text: string): IssueToolReply => ({ text, isError: true });
const success = (text: string): IssueToolReply => ({ text, isError: false });
const stateNames = {
  draft: "下書き",
  triage: "精査待ち",
  design: "設計待ち",
  design_review: "設計レビュー",
  ready: "実装待ち",
  implementing: "実装中",
  stopped: "停止中",
  done: "完了",
  withdrawn: "取り下げ",
};
const reportStates: Record<IssueReportName, string[]> = {
  report_triage: ["triage"],
  report_design: ["design"],
  report_needs_human: ["triage", "design", "implementing"],
  report_stage: ["implementing"],
  report_ready_for_merge: ["implementing"],
  report_ci_failed: ["implementing"],
  report_implementation_done: ["implementing"],
};

export function createToolHandlers(deps: IssueToolDeps) {
  return async (
    name: IssueToolName,
    input: unknown,
    context: ToolContext,
  ): Promise<IssueToolReply> => {
    const parsed = issueToolSchemas[name].safeParse(input);
    if (!parsed.success)
      return failure("入力の項目・長さ・番号・件数を確認して、もう一度呼んでください。");
    const repo = deps.data.read;
    const conversation = repo.conversation(context.conversationId);
    if (
      !conversation ||
      conversation.projectId !== context.projectId ||
      !repo.project(context.projectId)
    )
      return failure("会話またはプロジェクトが見つかりません。会話を開き直してください。");
    if (name === "issue_create") {
      const p = issueToolSchemas.issue_create.parse(parsed.data);
      if (p.designed !== undefined && !["chat", "thread", "design"].includes(conversation.kind))
        return failure(
          "この会話では designed を付けて issue を作れません。設計の会話か開発者が始めた会話で作ってください。",
        );
      const result = deps.flow.create(context.projectId, context.conversationId, p);
      return result.isErr()
        ? failure(result.error.message)
        : success(
            `${result.value.duplicate ? `#${result.value.number} は作成済みです` : `#${result.value.number} を作りました。精査待ちです`}\n${JSON.stringify({ number: result.value.number })}`,
          );
    }
    if (name === "issue_list") {
      const p = issueToolSchemas.issue_list.parse(parsed.data);
      const rows = repo
        .all(context.projectId)
        .filter(
          (row) =>
            (p.state === undefined || p.state.includes(row.state)) &&
            (p.text === undefined || row.title.includes(p.text) || row.body.includes(p.text)),
        )
        .slice(0, p.limit);
      return success(
        JSON.stringify(
          rows.map((row) => {
            const view = repo.view(row.id)!;
            return {
              number: row.number,
              title: row.title,
              state: row.state,
              priority: row.priority,
              parent: view.parent?.number ?? null,
              dependsOn: view.dependsOn.map((dependency) => dependency.number),
            };
          }),
        ),
      );
    }
    const number = (parsed.data as { number: number }).number;
    const reporting = name.startsWith("report_");
    const ownIssue =
      reporting && conversation.issueId !== null ? repo.get(conversation.issueId) : undefined;
    if (reporting && ownIssue?.number !== number)
      return failure(
        ownIssue
          ? `この会話が扱う issue は #${ownIssue.number} です`
          : "この会話は issue を扱っていません。対象の issue の会話で報告してください。",
      );
    const issue = repo.byNumber(context.projectId, number);
    if (!issue) return failure(`#${number} はこのプロジェクトにありません`);
    if (name === "issue_get") return success(JSON.stringify(repo.view(issue.id)));
    if (name === "issue_comment") {
      const p = issueToolSchemas.issue_comment.parse(parsed.data);
      const result = deps.flow.comment(issue.id, context.conversationId, p.text);
      return result.isErr()
        ? failure(result.error.message)
        : success(`#${number} にコメントを書きました`);
    }
    if (name === "issue_update") {
      if (issue.state === "draft") return failure("下書きは開発者がフォームで直します");
      const p = issueToolSchemas.issue_update.parse(parsed.data);
      const fields: IssueWriteInput = {
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.body === undefined ? {} : { body: p.body }),
        ...(p.parent === undefined ? {} : { parentNumber: p.parent }),
        ...(p.depends_on === undefined ? {} : { dependsOn: p.depends_on }),
        ...(p.priority === undefined ? {} : { priority: p.priority }),
        ...(p.kind === undefined ? {} : { kind: p.kind }),
        ...(p.confirm_before_merge === undefined
          ? {}
          : { confirmBeforeMerge: p.confirm_before_merge }),
      };
      const result = deps.flow.update(issue.id, fields, context.conversationId);
      return result.isErr()
        ? failure(result.error.message)
        : success(JSON.stringify(result.value.issue));
    }
    if (
      !reportStates[name].includes(issue.state) ||
      (name === "report_design" && repo.designPrPending(issue.id))
    )
      return failure(
        `#${number} はいま ${stateNames[issue.state]} なので、この報告を受け付けません`,
      );
    const result = await deps.reports.report(name, parsed.data, context);
    return result.isErr() ? failure(result.error.message) : success(result.value);
  };
}
