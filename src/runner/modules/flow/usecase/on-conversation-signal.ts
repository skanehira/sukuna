import type { ConversationRuntime, RuntimeSignal } from "../../conversation/usecase/runtime";
import { flowStage, hasFlowHistory } from "../domain/evaluate";
import type { StageRepository } from "../domain/stage-ports";
import type { IssueNoticePort } from "../domain/ports";
import { appendImplementationStage, moveStateWithin, type MoveStateCommand } from "./move-state";
import { firstLine } from "./on-report";

export function onConversationSignal(
  runtime: ConversationRuntime,
  repo: StageRepository,
  notices: IssueNoticePort,
  schedule: (projectId: string) => void,
  signal: RuntimeSignal,
) {
  if (
    signal.type !== "stopped" &&
    signal.type !== "inputRecorded" &&
    signal.type !== "runStateChanged" &&
    signal.type !== "turnEnded"
  )
    return;
  const c = runtime.store.get(signal.conversationId);
  if (!c?.issueId) return;
  const stage = c.kind === "impl" ? "implementing" : flowStage(c.kind);
  if (!stage) return;

  const id = c.issueId;
  const record = repo.read(id);
  if (!record || record.project.removedAt !== null) return;
  if (!hasFlowHistory(record.events)) {
    if (c.kind === "impl") schedule(c.projectId);
    return;
  }
  const events = () => runtime.store.events(c.id);
  let command: MoveStateCommand | undefined;
  if (
    signal.type === "inputRecorded" &&
    record.issue.state === "stopped" &&
    record.context.stoppedFrom === stage
  ) {
    command = { issueId: id, trigger: "agent_resumed" };
  } else if (record.issue.state === stage) {
    if (signal.type === "stopped") {
      const stopped = events().findLast((event) => event.type === "stopped");
      if (signal.reason === "usage_limit")
        command = { issueId: id, trigger: "agent_usage_limit", detail: "利用枠を使い切りました" };
      else if (["api_error", "error", "credits_required"].includes(signal.reason))
        command = {
          issueId: id,
          trigger: "agent_failed",
          detail:
            firstLine(stopped?.type === "stopped" ? (stopped.payload.detail ?? "") : "") ||
            "AI の実行に失敗しました。",
        };
    } else if (signal.type === "runStateChanged" && signal.current === "waiting_answer") {
      const question = events().findLast((event) => event.type === "question");
      command = {
        issueId: id,
        trigger: "agent_question",
        detail: firstLine(
          question?.type === "question" ? (question.payload.questions[0]?.question ?? "") : "",
        ),
      };
    }
  }
  if (command) {
    const input = command;
    const moved = runtime.store.withWorktreeReservation((reservation) =>
      repo.transaction((flow, data) => {
        const result = moveStateWithin(flow, input, repo.now());
        if (
          result.kind === "moved" &&
          c.kind === "impl" &&
          flow.getIssue(id)?.state === "implementing"
        )
          return appendImplementationStage(result, data, repo.now());
        return result;
      }, reservation),
    );
    if (moved.kind === "moved") {
      notices.publish(moved.notice);
      if (repo.read(id)?.issue.stopReason === "dependency_withdrawn")
        void runtime
          .stop(
            c.id,
            () => repo.read(id)?.issue.stopReason === "dependency_withdrawn",
            undefined,
            undefined,
            "dependency_withdrawn",
          )
          .catch((error: unknown) =>
            runtime.options.log(
              { conversationId: c.id, issueId: id },
              "依存先の取り下げ後に会話を停止できませんでした。",
              error,
            ),
          );
    }
  }
  schedule(c.projectId);
}
