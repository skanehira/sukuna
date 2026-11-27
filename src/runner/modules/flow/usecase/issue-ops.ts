import type { z } from "zod";
import { err, ok } from "neverthrow";
import { unavailableRunnerError } from "../../../../shared/ipc";
import {
  issueConflict,
  issueNotFound,
  type IssueDataRepository,
  type IssueDataUnitOfWork,
  type IssueError,
  type IssueOperationResult,
  type IssueClock,
  type IssueWriteInput,
} from "../../../../shared/issue/ports";
import { issueInputSchema, type issueToolSchemas } from "../../../../shared/issue/schema";
import { newIssue, prepareIssueWrite } from "../../../../shared/issue/rules";
import type { FinishWithdrawal, IssueRepositoryPort, IssueNoticePort } from "../domain/ports";
import { moveStateWithin } from "./move-state";

export type IssueOpsDeps = {
  data: IssueDataUnitOfWork;
  run<T>(action: (data: IssueDataRepository, state: IssueRepositoryPort) => T): T;
  withdraw(
    issueId: string,
    ownConversations: string[],
    callerCancelled?: () => boolean,
    finish?: FinishWithdrawal,
  ): Promise<{ kind: string }>;
  clear(issueId: string): unknown;
  hasDesignWorktree?(issueId: string): boolean;
  notices: IssueNoticePort;
  clock: IssueClock;
};
export function createIssueOps(deps: IssueOpsDeps) {
  const mutate = (
    id: string,
    input: IssueWriteInput,
    by: "developer" | "ai",
    conversationId: string | null,
  ): IssueOperationResult => {
    const result = deps.data.run((repo) => {
      const issue = repo.get(id);
      if (!issue || !repo.project(issue.projectId)) return err(issueNotFound);
      if (["done", "withdrawn", "draft"].includes(issue.state)) return err(issueConflict);
      if (input.priority === null)
        return err<never, IssueError>({
          code: "invalid_input",
          message: "確定した issue の優先度は無しに戻せません",
        });
      if (by === "developer" && (input.title !== undefined || input.body !== undefined))
        return err({
          code: "confirmed_text_locked" as const,
          message: "確定した issue の題名と本文は、会話で AI に頼んで直します",
        });
      const prepared = prepareIssueWrite(
        issue,
        input,
        repo.all(issue.projectId),
        repo.graph(issue.projectId),
      );
      if (prepared.error) return err(prepared.error);
      const now = deps.clock.now();
      repo.update(id, { ...prepared.fields, updatedAt: now }, prepared.dependencies);
      const event = repo.append(
        id,
        "edited",
        { fields: Object.keys(input), by, conversationId },
        now,
      );
      return ok({ issue: repo.view(id)!, event });
    });
    if (result.isErr()) return err(result.error);
    deps.notices.publish({
      kind: "issue",
      issue_id: id,
      project_id: result.value.issue.projectId,
      seq: result.value.event.seq,
    });
    return ok({ issue: result.value.issue });
  };
  return {
    edit(id: string, input: unknown): IssueOperationResult {
      const parsed = issueInputSchema.safeParse(input);
      if (!parsed.success)
        return err({
          code: "invalid_input",
          message: "入力の長さ・番号・件数を確認してください。",
        });
      return mutate(id, parsed.data, "developer", null);
    },
    update: (id: string, input: IssueWriteInput, conversationId: string) =>
      mutate(id, input, "ai", conversationId),
    confirm(id: string): IssueOperationResult {
      const result = deps.run((repo, state) => {
        const issue = repo.get(id);
        if (!issue || !repo.project(issue.projectId)) return err(issueNotFound);
        if (issue.state !== "draft") return err(issueConflict);
        if (!issue.title.trim())
          return err({
            code: "title_required" as const,
            message: "題名を書いてから確定してください",
          });
        const now = deps.clock.now();
        const moved = moveStateWithin(state, { issueId: id, trigger: "confirm" }, now);
        if (moved.kind !== "moved") return err(issueConflict);
        const event = repo.append(id, "created", { by: "developer", conversationId: null }, now);
        return ok({ issue: repo.view(id)!, event });
      });
      if (result.isErr()) return err(result.error);
      deps.notices.publish({
        kind: "issue",
        issue_id: id,
        project_id: result.value.issue.projectId,
        seq: result.value.event.seq,
      });
      return ok({ issue: result.value.issue });
    },
    async withdraw(
      id: string,
      callerCancelled = () => false,
      finish?: FinishWithdrawal,
    ): Promise<IssueOperationResult> {
      if (callerCancelled()) return err(unavailableRunnerError);
      const repo = deps.data.read;
      const issue = repo.view(id);
      if (!issue) return err(issueNotFound);
      if (["done", "withdrawn"].includes(issue.state)) return err(issueConflict);
      const dependents = issue.dependents.filter(
        (row) => !["draft", "done", "withdrawn", "stopped"].includes(row.state),
      );
      const design =
        ["design", "design_review"].includes(issue.state) || deps.hasDesignWorktree?.(id);
      const result = await deps.withdraw(
        id,
        repo.activeConversationIds(id),
        callerCancelled,
        design ? finish : undefined,
      );
      if (result.kind === "caller_cancelled") return err(unavailableRunnerError);
      if (result.kind === "stop_failed")
        return err({
          code: "internal",
          message:
            "取り下げは保存しましたが、AI を停止できませんでした。会話の状態を確認してください。",
        });
      if (result.kind !== "moved") return err(issueConflict);
      return ok({
        issue: repo.view(id)!,
        stoppedDependents: dependents
          .filter((row) => repo.get(row.id)?.stopReason === "dependency_withdrawn")
          .map((row) => row.number),
      });
    },
    reopen(id: string): IssueOperationResult {
      const result = deps.run((repo, state) => {
        const issue = repo.get(id);
        if (!issue || !repo.project(issue.projectId)) return err(issueNotFound);
        const moved = moveStateWithin(state, { issueId: id, trigger: "reopen" }, deps.clock.now());
        return moved.kind === "moved"
          ? ok({ issue: repo.view(id)!, notice: moved.notice })
          : err(issueConflict);
      });
      if (result.isErr()) return err(result.error);
      deps.notices.publish(result.value.notice);
      for (const dependent of result.value.issue.dependents) deps.clear(dependent.id);
      return ok({ issue: deps.data.read.view(id)! });
    },
    create(
      projectId: string,
      conversationId: string,
      input: z.infer<typeof issueToolSchemas.issue_create>,
    ) {
      const result = deps.data.create((repo) => {
        const project = repo.project(projectId);
        if (!project) return err(issueNotFound);
        const now = deps.clock.now();
        const duplicate = repo
          .all(projectId)
          .find(
            (issue) =>
              issue.createdConversationId === conversationId &&
              issue.title === input.title &&
              !["done", "withdrawn"].includes(issue.state) &&
              issue.createdAt >= now - 600000,
          );
        if (duplicate)
          return ok({ number: duplicate.number, duplicate: true, event: null, id: duplicate.id });
        const issue = newIssue(
          deps.clock.id(),
          projectId,
          repo.nextNumber(projectId),
          now,
          input.confirm_before_merge ?? project.confirmBeforeMergeDefault,
        );
        const fields = {
          title: input.title,
          body: input.body,
          ...(input.parent === undefined ? {} : { parentNumber: input.parent }),
          ...(input.depends_on === undefined ? {} : { dependsOn: input.depends_on }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.designed === undefined ? {} : { designed: input.designed }),
        };
        const prepared = prepareIssueWrite(
          issue,
          fields,
          repo.all(projectId),
          repo.graph(projectId),
        );
        if (prepared.error) return err(prepared.error);
        repo.insert(
          { ...issue, ...prepared.fields, state: "triage", createdConversationId: conversationId },
          prepared.dependencies,
        );
        repo.append(
          issue.id,
          "state_changed",
          { from: null, to: "triage", stopReason: null, detail: null, cause: "ai_created" },
          now,
        );
        const event = repo.append(issue.id, "created", { by: "ai", conversationId }, now);
        return ok({ number: issue.number, duplicate: false, event, id: issue.id });
      });
      if (result.isOk() && result.value.event)
        deps.notices.publish({
          kind: "issue",
          issue_id: result.value.id,
          project_id: projectId,
          seq: result.value.event.seq,
        });
      return result;
    },
    comment(id: string, conversationId: string, text: string) {
      const event = deps.data.run((repo) =>
        repo.append(id, "comment", { text, conversationId }, deps.clock.now()),
      );
      const issue = deps.data.read.get(id)!;
      deps.notices.publish({
        kind: "issue",
        issue_id: id,
        project_id: issue.projectId,
        seq: event.seq,
      });
      return ok(undefined);
    },
  };
}
export type IssueOps = ReturnType<typeof createIssueOps>;
