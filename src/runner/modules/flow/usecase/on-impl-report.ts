import { err, ok } from "neverthrow";
import { issueConflict, type ToolContext } from "../../../../shared/issue/ports";
import { issueToolSchemas } from "../../../../shared/issue/schema";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import type { IssueReportsPort } from "../../issue/domain/ports";
import type { IssueNoticePort } from "../domain/ports";
import type { StageRepository } from "../domain/stage-ports";
import type { ImplementationGithub } from "../domain/impl-ports";
import type { createImplementationStart } from "./start-implementation";
import type { createImplementationCompletion } from "./complete-implementation";
import {
  implementationApproval,
  implementationReady,
  issueHistoryPoint,
  readyDetails,
} from "../domain/impl-history";
import { firstLine } from "./on-report";
import { moveStateWithin } from "./move-state";

const stopForMerge =
  "merge 前の確認で止めました。番を終えてください。開発者が許可すると、この会話に merge の指示が届きます";
const stopForHuman = "停止中にしました。番を終えてください。回答はこの会話に届きます";
const conflict = new Error(issueConflict.message);

export function createImplementationReports(
  repo: StageRepository,
  runtime: ConversationRuntime,
  notices: IssueNoticePort,
  start: ReturnType<typeof createImplementationStart>,
  complete: ReturnType<typeof createImplementationCompletion>["complete"],
  github: ImplementationGithub,
): IssueReportsPort {
  function read(context: ToolContext) {
    const record = context.issueId && repo.read(context.issueId);
    const c = repo.data.conversation(context.conversationId);
    if (
      !record ||
      !c ||
      c.kind !== "impl" ||
      runtime.store.get(c.id)?.closedAt !== null ||
      record.issue.id !== c.issueId ||
      record.issue.state !== "implementing" ||
      record.project.removedAt !== null ||
      c.projectId !== context.projectId ||
      record.project.id !== context.projectId
    )
      return;
    return record;
  }

  return {
    async report(name, input, context) {
      const record = read(context);
      if (!record) return err(issueConflict);
      const { issue, project, events } = record;
      const tree = start.activeTree(project.id, context.conversationId);
      if (!tree) return err(issueConflict);
      let verifiedUrl: string | null = null;
      let comparisonBase: string | null = null;
      let approvedReadySeq: number | undefined;
      let release: (() => Promise<void>) | undefined;
      if (name === "report_implementation_done") {
        const report = issueToolSchemas.report_implementation_done.parse(input);
        return complete(issue.id, {
          source: "agent",
          conversationId: context.conversationId,
          prUrl: report.pr_url,
          mergeCommit: report.merge_commit,
          summary: report.summary,
        });
      }
      if (name === "report_triage" || name === "report_design") return err(issueConflict);
      if (name === "report_ready_for_merge") {
        const report = issueToolSchemas.report_ready_for_merge.parse(input);
        const failure = (message: string) => err({ code: "conflict" as const, message });
        const local = await start.headAt(tree.path);
        if (local.isErr() || local.value.toLowerCase() !== report.head_sha.toLowerCase())
          return failure("実装の worktree の先頭と報告した head_sha が一致しません。");
        if (project.usesGithub) {
          if (!report.pr_url) return failure("実装の PR の URL を指定してください。");
          const target = await start.repository(project);
          if (target.isErr()) return failure(target.error.message);
          if (target.value === null) return failure("GitHub のリポジトリが見つかりません。");
          const current = await github.view(
            project.path,
            { repository: target.value, base: project.defaultBranch, branch: tree.branch },
            report.pr_url,
          );
          if (current.isErr()) return failure(current.error.message);
          if (current.value.state !== "OPEN") return failure("PR は開かれていません。");
          if (current.value.head.toLowerCase() !== report.head_sha.toLowerCase())
            return failure("PR の先頭のコミットと報告した head_sha が一致しません。");
          verifiedUrl = current.value.url;
          comparisonBase = await start.comparisonBase(
            tree.path,
            local.value,
            current.value.baseTip,
          );
          const previous = implementationReady(events);
          const prior = readyDetails(previous);
          const grantedSeq = implementationApproval(events, previous);
          const granted = readyDetails(events.find((event) => event.seq === grantedSeq));
          if (
            report.rebased &&
            prior?.prUrl === verifiedUrl &&
            prior.worktreeId === tree.id &&
            comparisonBase &&
            granted?.comparisonBase &&
            (await start.sameChange(
              tree.path,
              { base: granted.comparisonBase, head: granted.head },
              { base: comparisonBase, head: local.value },
            ))
          )
            approvedReadySeq = grantedSeq;
        } else if (report.pr_url) {
          return failure("GitHub を使わないプロジェクトです。PR の URL を外してください。");
        }
        const protectedHead = await start.protect(project, tree, local.value);
        if (protectedHead.isErr())
          return failure(
            "実装の worktree の先頭が変わりました。確認してからもう一度報告してください。",
          );
        release = () => protectedHead.value.release();
      }
      try {
        const result = runtime.store.withWorktreeReservation((reservation) =>
          repo.transaction((flow, data) => {
            const current = read(context);
            if (
              !current ||
              issueHistoryPoint(current.events) !== issueHistoryPoint(events) ||
              current.project.usesGithub !== project.usesGithub ||
              current.project.defaultBranch !== project.defaultBranch ||
              start.activeTree(project.id, context.conversationId)?.id !== tree.id
            )
              throw conflict;
            const now = repo.now();
            const append = (type: string, payload: object) =>
              data.append(issue.id, type, payload, now);
            const move = (
              trigger: "ready_for_merge" | "ci_failed" | "needs_human",
              detail: string,
            ) => {
              const result = moveStateWithin(flow, { issueId: issue.id, trigger, detail }, now);
              if (result.kind !== "moved") throw conflict;
            };
            const stage = (value: "review" | "pr" | "ci" | "merge") => {
              const last = current.events.findLast((event) => event.type === "stage_changed");
              if ((last?.payload as { stage?: string } | undefined)?.stage !== value)
                append("stage_changed", { stage: value });
            };

            switch (name) {
              case "report_stage":
                stage(issueToolSchemas.report_stage.parse(input).stage);
                return "記録しました";
              case "report_ready_for_merge": {
                const { head_sha, rebased, summary } =
                  issueToolSchemas.report_ready_for_merge.parse(input);
                const previous = implementationReady(current.events);
                if (previous?.seq !== implementationReady(events)?.seq) throw conflict;
                append("ready_for_merge", {
                  prUrl: verifiedUrl,
                  headSha: head_sha.toLowerCase(),
                  rebased,
                  summary,
                  worktreeId: tree.id,
                  ...(comparisonBase ? { comparisonBase } : {}),
                  ...(approvedReadySeq === undefined ? {} : { approvedReadySeq }),
                });
                data.update(issue.id, { prUrl: verifiedUrl });
                if (current.issue.confirmBeforeMerge && approvedReadySeq === undefined) {
                  move("ready_for_merge", "merge 前の確認");
                  return stopForMerge;
                }
                if (project.usesGithub) {
                  stage("ci");
                  return "CI を待って merge してください";
                }
                return "merge してください";
              }
              case "report_ci_failed": {
                const { checks, timed_out, summary } =
                  issueToolSchemas.report_ci_failed.parse(input);
                append("ci_failed", { checks, timedOut: timed_out, summary });
                move(
                  "ci_failed",
                  timed_out
                    ? "CI が 60 分で終わりませんでした"
                    : checks.map(({ name }) => name).join("、"),
                );
                return "停止中にしました。番を終えてください";
              }
              case "report_needs_human": {
                const { questions, summary } = issueToolSchemas.report_needs_human.parse(input);
                append("needs_human_reported", {
                  questions: questions.map(({ text, options }) => ({
                    text,
                    options: options ?? [],
                  })),
                  summary,
                });
                move(
                  "needs_human",
                  firstLine(questions[0]!.text) || "AI から回答を求められています。",
                );
                return stopForHuman;
              }
            }
          }, reservation),
        );
        const sequence = repo.events(issue.id).at(-1)?.seq;
        if (sequence !== undefined && sequence !== events.at(-1)?.seq)
          notices.publish({
            kind: "issue",
            issue_id: issue.id,
            project_id: project.id,
            seq: sequence,
          });
        return ok(result);
      } catch (error) {
        if (error === conflict) return err(issueConflict);
        throw error;
      } finally {
        await release?.();
      }
    },
  };
}
