import { err, ok } from "neverthrow";
import { issueConflict } from "../../../../shared/issue/ports";
import { issueToolSchemas } from "../../../../shared/issue/schema";
import type { IssueReportsPort } from "../../issue/domain/ports";
import type { StageDesign, StageRepository } from "../domain/stage-ports";
import type { IssueNoticePort } from "../domain/ports";
import { triagePriority } from "../domain/priority";
import { moveStateWithin } from "./move-state";

class ReportStateChanged extends Error {}

export function firstLine(text: string) {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

export function createStageReports(
  repo: StageRepository,
  notices: IssueNoticePort,
  design: Pick<StageDesign, "submit">,
  fallback: IssueReportsPort,
): IssueReportsPort {
  return {
    async report(name, input, context) {
      const id = context.issueId;
      if (!id) return err(issueConflict);
      if (name === "report_design") {
        const parsed = issueToolSchemas.report_design.parse(input);
        const result = await design.submit(id, context.conversationId, parsed);
        return result.isErr()
          ? err({
              code: result.error.code === "not_found" ? "not_found" : "conflict",
              message: result.error.message,
            })
          : ok("設計レビューにしました。番を終えてください");
      }
      if (
        (name !== "report_triage" && name !== "report_needs_human") ||
        (name === "report_needs_human" &&
          repo.data.conversation(context.conversationId)?.kind === "impl")
      )
        return fallback.report(name, input, context);

      const storeReport = () =>
        repo.transaction((flow, data) => {
          const issue = data.get(id);
          const conversation = data.conversation(context.conversationId);
          if (
            !issue ||
            !data.project(context.projectId) ||
            issue.projectId !== context.projectId ||
            conversation?.issueId !== id ||
            conversation.kind !== issue.state ||
            (name === "report_triage" && issue.state !== "triage")
          )
            return err(issueConflict);
          const facts = flow.contextOf(issue);
          if (facts.designPrMergePending) return err(issueConflict);
          const now = repo.now();
          if (name === "report_triage") {
            const { result, kind, urgent, score, summary } =
              issueToolSchemas.report_triage.parse(input);
            if (result === "parent" && !facts.hasChildren)
              return err({
                code: "conflict" as const,
                message: `#${issue.number} には子がありません。設計へ進めるなら result を design にしてください`,
              });
            const parent = issue.parentId ? data.get(issue.parentId) : undefined;
            const priority = issue.priority ?? triagePriority(urgent, parent?.priority, score);
            data.append(
              id,
              "triage_reported",
              { result, kind, urgent, score: score ?? null, priority, summary },
              now,
            );
            data.update(id, { kind, priority });
            const moved = moveStateWithin(
              flow,
              { issueId: id, trigger: "triage_reported", facts: { triageResult: result } },
              now,
            );
            if (moved.kind !== "moved") throw new ReportStateChanged();
            const state = flow.getIssue(id)?.state;
            const destination =
              state === "design" ? "設計待ち" : facts.hasChildren ? "実装待ち (親)" : "実装待ち";
            return ok({
              notice: moved.notice,
              reply: `${destination}にしました。番を終えてください`,
            });
          }
          const { questions, summary } = issueToolSchemas.report_needs_human.parse(input);
          data.append(
            id,
            "needs_human_reported",
            {
              questions: questions.map(({ text, options }) => ({ text, options: options ?? [] })),
              summary,
            },
            now,
          );
          const moved = moveStateWithin(
            flow,
            {
              issueId: id,
              trigger: "needs_human",
              detail: firstLine(questions[0]!.text) || "AI から回答を求められています。",
            },
            now,
          );
          if (moved.kind !== "moved") throw new ReportStateChanged();
          return ok({
            notice: moved.notice,
            reply: "停止中にしました。番を終えてください。回答はこの会話に届きます",
          });
        });
      try {
        const result = storeReport();
        if (result.isErr()) return err(result.error);
        notices.publish(result.value.notice);
        return ok(result.value.reply);
      } catch (error) {
        if (error instanceof ReportStateChanged) return err(issueConflict);
        throw error;
      }
    },
  };
}
