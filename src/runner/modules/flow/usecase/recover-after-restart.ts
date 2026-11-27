import { designEvents } from "../../../../shared/api/design";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import type { StageDesign, StageRepository } from "../domain/stage-ports";
import { flowStage } from "../domain/evaluate";
import type { createMoveState } from "./move-state";
import { firstLine } from "./on-report";

export async function recoverAfterRestart(
  repo: StageRepository,
  runtime: ConversationRuntime,
  design: StageDesign,
  move: ReturnType<typeof createMoveState>,
  schedule: (projectId: string) => void,
  logFailure: (error: unknown, issueId: string) => void,
) {
  for (const c of runtime.store.list()) {
    if (
      !c.issueId ||
      c.runState !== "stopped" ||
      c.stopReason !== "restarted" ||
      !flowStage(c.kind)
    )
      continue;
    const record = repo.read(c.issueId);
    if (record?.issue.state !== c.kind || record.project.removedAt !== null) continue;
    const events = runtime.store.events(c.id);
    const stopped = events.findLast((event) => event.type === "stopped");
    if (stopped?.type !== "stopped" || stopped.payload.previous_run_state !== "waiting_answer")
      continue;
    const question = events.findLast((event) => event.type === "question");
    const detail =
      question?.type === "question" ? (question.payload.questions[0]?.question ?? "") : "";
    move({ issueId: c.issueId, trigger: "restart_question", detail: firstLine(detail) });
  }
  for (const project of repo.projects()) {
    if (runtime.closing) return;
    for (const issue of repo.issues(project.id)) {
      const record = repo.read(issue.id);
      if (record?.issue.state === "design_review" && designEvents(record.events).reflecting)
        await design
          .recoverApproval(issue.id)
          .catch((error: unknown) => logFailure(error, issue.id));
    }
    schedule(project.id);
  }
}
