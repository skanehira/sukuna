import { ok } from "neverthrow";
import { designPrInput, designPrStarted } from "../domain/design-pr-activity";
import { designEvents, designPrCreatedSchema } from "../../../../shared/api/design";
import type { StoredEvent } from "../../../../shared/events";
import type { Conversation } from "../../conversation/domain/conversation-store";
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
import type { StageDesign, StageRepository } from "../domain/stage-ports";
import {
  evaluate,
  flowStage,
  hasFlowHistory,
  startingPoint,
  stateChange,
  type FlowEvent,
  type Stage,
} from "../domain/evaluate";
import {
  firstInstruction,
  missingReport,
  nudgeInstruction,
  restartInstruction,
  resumeDependency,
} from "../domain/instructions";
import type { IssueNoticePort } from "../domain/ports";
import type { createFlowGate } from "./flow-gate";
import type { createMoveState } from "./move-state";
import type { createImplementationStart } from "./start-implementation";
import type { createImplementationCompletion } from "./complete-implementation";

type Snapshot = NonNullable<ReturnType<StageRepository["read"]>>;
type Run = {
  text: string;
  type: "ai_started" | "report_nudged";
  reason?: "start" | "reopen" | "resume_dependency" | "restart";
  revision: number;
};
const titles = { triage: "精査", design: "設計" };

function started(event: FlowEvent, stage: Stage, reason?: string) {
  if (event.type !== "ai_started" || typeof event.payload !== "object" || !event.payload)
    return false;
  const value = event.payload as { kind?: string; reason?: string };
  return value.kind === stage && (reason === undefined || value.reason === reason);
}

function sentAfter(events: StoredEvent[], since: FlowEvent) {
  return events.some(
    (event) => event.type === "user_message" && event.createdAt >= since.createdAt,
  );
}

export function createEvaluateProject(deps: {
  repo: StageRepository;
  runtime: ConversationRuntime;
  design: StageDesign;
  notices: IssueNoticePort;
  allows: ReturnType<typeof createFlowGate>;
  move: ReturnType<typeof createMoveState>;
  implementation: Pick<
    ReturnType<typeof createImplementationCompletion>,
    "observe" | "cleanupIfClosed"
  > &
    Pick<ReturnType<typeof createImplementationStart>, "evaluate">;
}) {
  const { repo, runtime, design, notices, allows, move, implementation } = deps;
  const conversations = (id: string) => runtime.store.list().filter((c) => c.issueId === id);
  const busy = (list: Conversation[]) =>
    list.some(
      (c) => ["triage", "design", "impl"].includes(c.kind) && activeStates.includes(c.runState),
    );

  async function deliver(id: string, stage: Stage, c: Conversation, run: Run) {
    await runtime.serial(c.id, async () => {
      const check = () => {
        const current = repo.read(id);
        return !current ||
          current.project.removedAt !== null ||
          current.issue.state !== stage ||
          (current.events.at(-1)?.seq ?? 0) !== run.revision ||
          runtime.store.get(c.id)?.lastSeq !== c.lastSeq ||
          !allows(c.projectId, stage) ||
          busy(conversations(id))
          ? { code: "conflict" as const, message: "段階の実行条件が変わりました。" }
          : null;
      };
      if (check() || runtime.closing) return ok(undefined);
      let seq: number | undefined;
      const result = await runtime.deliver(
        c.id,
        { text: run.text, images: [], origin: "flow" },
        {
          events: [],
          check,
          before: () => {
            seq = repo.append(
              id,
              run.type,
              run.type === "ai_started"
                ? { kind: stage, conversationId: c.id, reason: run.reason }
                : { conversationId: c.id },
            ).seq;
          },
        },
        { includeQueued: false },
      );
      if (result.isOk() && seq !== undefined)
        notices.publish({ kind: "issue", issue_id: id, project_id: c.projectId, seq });
      return result;
    });
  }

  async function start(
    record: Snapshot,
    stage: Stage,
    existing: Conversation | undefined,
    revision: number,
    reopen: boolean,
  ) {
    const { issue, project } = record;
    const projectRun = runtime.store.reserveProjectRun(project.id);
    try {
      let c = existing;
      if (!c) {
        const result = await runtime.start({
          projectId: project.id,
          cwd: project.path,
          kind: stage,
          title: `#${issue.number} の${titles[stage]}`,
          issueId: issue.id,
        });
        if (result.isErr()) return;
        c = runtime.store.get(result.value.conversationId) ?? undefined;
      }
      if (!c) return;
      let tree;
      if (stage === "design") {
        const prepared = await design.workspace({ issueId: issue.id, conversationId: c.id });
        if (prepared.isErr()) return;
        tree = prepared.value;
      }
      await deliver(issue.id, stage, c, {
        text: firstInstruction(stage, issue, project, tree, reopen),
        type: "ai_started",
        reason: reopen ? "reopen" : "start",
        revision,
      });
    } finally {
      projectRun.release();
    }
  }

  async function evaluateIssue(id: string) {
    if (runtime.closing) return;
    await implementation.observe(id);
    await implementation.cleanupIfClosed(id);
    await implementation.evaluate(id);
    const record = repo.read(id);
    if (!record || record.project.removedAt !== null || !hasFlowHistory(record.events)) return;
    const { issue, context, project, events } = record;
    const stage = flowStage(issue.state === "stopped" ? (context.stoppedFrom ?? "") : issue.state);
    if (!stage) return;
    const all = conversations(id);
    const c = all.find((item) => item.kind === stage && item.closedAt === null);
    const messages = c ? runtime.store.events(c.id) : [];
    const last = events.at(-1);
    const revision = last?.seq ?? 0;
    const allowed = allows(project.id, stage);
    const occupied = busy(all);

    if (issue.state === "stopped") {
      const stop = messages.findLast((event) => event.type === "stopped");
      if (
        allowed &&
        !occupied &&
        issue.stopReason === "usage_limit" &&
        c?.runState === "usage_limited" &&
        stop &&
        repo.now() >= (c.resetsAt === null ? stop.createdAt + 15 * 60_000 : c.resetsAt + 60_000)
      )
        await runtime.resume(c.id, "usage_limit");
      return;
    }
    const origin = startingPoint(events, stage);
    const history = designEvents(events);
    const pr = context.designPrMergePending ? history.pr : undefined;
    const prStarted = pr ? designPrStarted(pr, events, messages) : false;
    const managedDesign = events.some(
      (event) =>
        (stateChange(event)?.cause === "triage_reported" && stateChange(event)?.to === "design") ||
        started(event, "design", "start") ||
        started(event, "design", "worktree_retry"),
    );
    if (pr && prStarted && c?.runState === "idle" && managedDesign) {
      const mergeTurn = designPrInput(pr, messages);
      const ended = messages.findLast(
        (event) => event.type === "turn_end" && event.payload.subtype === "success",
      );
      if (mergeTurn && ended && mergeTurn.seq < ended.seq) {
        await design.drain();
        if (
          runtime.closing ||
          busy(conversations(id)) ||
          repo.read(id)?.events.at(-1)?.seq !== revision
        )
          return;
        const answer = messages.findLast(
          (event) =>
            event.type === "assistant_text" && event.seq > mergeTurn.seq && event.seq < ended.seq,
        );
        await design.completePr(id, answer?.type === "assistant_text" ? answer.payload.text : "");
        return;
      }
    }
    if (occupied) return;
    const lastChange = events.findLast((event) => event.type === "state_changed");
    const cause = stateChange(lastChange)?.cause;
    const activityAfter = (event: FlowEvent) =>
      events.some((row) => row.seq > event.seq && started(row, stage)) ||
      sentAfter(messages, event);
    const action = evaluate({
      stage,
      pendingPr: Boolean(pr),
      started: pr ? Boolean(prStarted) : !origin || activityAfter(origin),
      projectActive: project.removedAt === null,
      paused: !allowed,
      stageEnabled: project.autoStages.includes(stage),
      busy: occupied,
      hasWithdrawnDependencies: context.hasWithdrawnDependencies === true,
    });
    if (
      action === "dependency_withdrawn" ||
      (allowed && context.hasWithdrawnDependencies && cause === "dependency_cleared")
    ) {
      move({ issueId: id, trigger: "dependency_withdrawn" });
      return;
    }
    if (action === "pr") {
      const result = designPrCreatedSchema.safeParse(pr?.payload);
      if (result.success) await design.sendPrInstruction(id, result.data.prUrl);
      return;
    }
    const stop = messages.findLast((event) => event.type === "stopped");
    if (
      allowed &&
      c?.runState === "stopped" &&
      c.stopReason === "restarted" &&
      stop?.type === "stopped" &&
      stop.payload.previous_run_state !== "waiting_answer"
    ) {
      if (context.hasWithdrawnDependencies) move({ issueId: id, trigger: "dependency_withdrawn" });
      else
        await deliver(id, stage, c, {
          text: restartInstruction,
          type: "ai_started",
          reason: "restart",
          revision,
        });
      return;
    }
    if (
      allowed &&
      c &&
      messages.some((event) => event.type === "user_message") &&
      lastChange &&
      cause === "dependency_cleared" &&
      (stop?.type !== "stopped" ||
        stop.payload.reason !== "user" ||
        stop.payload.flow_trigger === "dependency_withdrawn") &&
      !activityAfter(lastChange)
    ) {
      await deliver(id, stage, c, {
        text: resumeDependency,
        type: "ai_started",
        reason: "resume_dependency",
        revision,
      });
      return;
    }
    if (action === "start") {
      await start(record, stage, c, revision, stateChange(origin)?.cause === "reopen");
      return;
    }
    if (!pr && c?.runState === "idle" && origin) {
      const ai = events.findLast((event) => event.seq > origin.seq && started(event, stage));
      const latestInput = messages.findLast((event) => event.type === "user_message");
      const end = messages.findLast((event) => event.type === "turn_end");
      const automatic =
        latestInput?.type === "user_message" &&
        !["developer", "stock", "queued", "interrupt", "answer_text"].includes(
          latestInput.payload.origin,
        );
      if (
        !ai ||
        !latestInput ||
        !automatic ||
        end?.type !== "turn_end" ||
        end.payload.subtype !== "success" ||
        end.seq <= latestInput.seq ||
        events.some(
          (event) =>
            event.seq > ai.seq &&
            ["triage_reported", "design_submitted", "needs_human_reported"].includes(event.type),
        )
      )
        return;
      if (events.some((event) => event.seq > ai.seq && event.type === "report_nudged"))
        move({ issueId: id, trigger: "no_report", detail: missingReport });
      else if (allowed)
        await deliver(id, stage, c, {
          text: nudgeInstruction(stage),
          type: "report_nudged",
          revision,
        });
    }
  }

  return evaluateIssue;
}
