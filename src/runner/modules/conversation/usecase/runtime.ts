import type { RestoreConversationDraft } from "../../../../shared/conversation/api";
import type { TimelineAnchor } from "../../../../shared/progress/draft";
import { RunOptions } from "./run-options";
import type { CommandCache } from "../domain/agent-port";
import {
  ConversationWorkspaceChanged,
  ConversationWriteBusy,
  ProjectRunBlocked,
} from "../domain/conversation-store";
import { WorktreeActivityBusy } from "../../../../shared/workspace/worktree-activity";
import { RUNNER_IPC_TIMEOUT_MS, STOCK_SEND_SETTLEMENT_TIMEOUT_MS } from "../../../../shared/ipc";
import { deliverQueue } from "./deliver-queue";
import { start } from "./start";
import { send } from "./send";
import { stop } from "./stop";
import { resume } from "./resume";
import { fork } from "./fork";
import { answer } from "./answers";
import { permission } from "./permissions";
import { release } from "./release";
import { ReleaseReservations } from "./release-reservations";
import { err, ok, type Result } from "neverthrow";
import type {
  AgentPort,
  AgentSession,
  AgentOutput,
  QuestionRequest,
  PermissionRequest,
  PermissionDecision,
} from "../domain/agent-port";
import type { ImagePort, LoadedImage } from "../domain/image-port";
import type { Clock } from "../domain/clock";
import type {
  AcceptedInstruction,
  Conversation,
  ConversationStore,
  ProjectRunReservation,
  SendResult,
} from "../domain/conversation-store";
import { classifyStop, type RateLimit, type StopIntent } from "../domain/stop-reason";
import { outputEvents } from "../domain/event-mapping";
import type { ConversationEvent, StoredEvent, Origin, RunState } from "../../../../shared/events";
import { AppToolRegistry } from "./app-tool-registry";
import { UsageLimitTimer } from "./usage-limit-timer";
import { recordRateLimit } from "./record-rate-limit";
import type { TimelineInputComment } from "../../../../shared/progress/schema";
import { unavailableRunnerError } from "../../../../shared/ipc";

export type OperationError = {
  code: "conflict" | "not_found" | "internal" | "invalid_input" | "runner_unavailable";
  message: string;
};
export type DeliveryError = OperationError | { code: "worktree_failed"; message: string };
export type RuntimeSignal = { conversationId: string } & (
  | { type: "event"; event: StoredEvent }
  | { type: "turnEnded"; startSeq: number; endSeq: number; subtype: string }
  | { type: "runStateChanged"; previous: RunState; current: RunState }
  | { type: "stopped"; reason: string; previousRunState?: RunState }
  | { type: "inputRecorded"; seq: number; eventType: string }
  | { type: "delta"; text: string }
  | { type: "parts"; parts: ("queue" | "answers" | "stock" | "threads" | "draft")[] }
);
export type RuntimeOptions = {
  store: ConversationStore;
  agent: AgentPort;
  images: ImagePort;
  clock: Clock;
  id: () => string;
  uuid: () => string;
  canResume?: (conversation: Conversation) => Promise<boolean>;
  log: (
    context: { conversationId: string; issueId: string | null },
    message: string,
    error?: unknown,
  ) => void;
  notice: (conversationId: string, message: string, level: "info" | "error") => void;
  tools?: AppToolRegistry;
  commands?: CommandCache;
};
export type SendInput = {
  text: string;
  images: string[];
  clientId?: string;
  interrupt?: boolean;
  origin: Origin;
  timelineComments?: TimelineInputComment[];
  timelineAnchors?: TimelineAnchor[];
  restoreDraft?: RestoreConversationDraft;
};
type DeliveryOptions = {
  includeQueued?: boolean;
  prefix?: string;
  checkStage?: "owner" | "accepted";
  interrupt?: boolean;
  omitMissingImages?: boolean;
  reopensAfterAcceptance?: boolean | "stock";
  projectRun?: ProjectRunReservation;
  newConversation?: Conversation;
  recordOpeningFailure?: boolean;
  afterAcceptance?: boolean;
};
export type InputAcceptance = {
  workspace?: { path: string; id: string };
  events: ConversationEvent[];
  before?: () => void;
  check?: () => OperationError | null;
  checkBeforeCommit?: () => OperationError | null;
};
export function callerInputAcceptance(
  callerCancelled: (() => boolean) | undefined,
  events: ConversationEvent[] = [],
): InputAcceptance | undefined {
  if (!callerCancelled) return undefined;
  const check = () => (callerCancelled() ? unavailableRunnerError : null);
  return { events, check, checkBeforeCommit: check };
}
export class InputRefused extends Error {
  readonly refusal: OperationError;
  constructor(refusal: OperationError) {
    super(refusal.message);
    this.refusal = refusal;
  }
}
type Reopening = { closedAt: number; until: number };
const reopenWaitMs = RUNNER_IPC_TIMEOUT_MS + 5_000;
type Execution = {
  cwd: string;
  worktreeId: string | null;
  session: AgentSession;
  consuming: Promise<void>;
  ended: Promise<void>;
  end: () => void;
  intent: StopIntent | null;
  rate: RateLimit | null;
  assistantError: string | null;
  startSeq: number;
  question?: {
    request: QuestionRequest;
    resolve: (answer: Record<string, string>) => void;
    reject: (reason: Error) => void;
  };
  permission?: { request: PermissionRequest; resolve: (answer: PermissionDecision) => void };
  inputOrigin: Origin;
  reopening: Reopening | null;
  acceptedInputId?: string;
  refusedInterrupt?: { startSeq: number; message: string };
  streamEnded: boolean;
  turnActive: boolean;
};
function turnHasEnded(execution: Execution): boolean {
  return !execution.turnActive || execution.streamEnded;
}
export const activeStates: RunState[] = ["working", "waiting_answer", "waiting_permission"];
export const conflict = (
  message = "会話の状態が変わりました。もう一度操作してください。",
): OperationError => ({ code: "conflict", message });
export class ConversationRuntime {
  readonly store: ConversationStore;
  readonly tools: AppToolRegistry;
  readonly runOptions: RunOptions;
  readonly timers: UsageLimitTimer;
  readonly releases: ReleaseReservations;
  executions = new Map<string, Execution>();
  private operations = new Map<string, Promise<unknown>>();
  private acceptedDeliveries = new Map<string, { instructionId: string; job: Promise<void> }>();
  private listeners = new Set<(signal: RuntimeSignal) => void | Promise<void>>();
  closing = false;
  options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = options;
    this.store = options.store;
    this.tools = options.tools ?? new AppToolRegistry();
    this.runOptions = new RunOptions(options.store, this.tools);
    this.timers = new UsageLimitTimer(options.clock);
    this.releases = new ReleaseReservations(this);
  }
  subscribe(listener: (signal: RuntimeSignal) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private signal(signal: RuntimeSignal): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(signal)).catch((error: unknown) => {
          this.log(signal.conversationId, "会話の合図の受け手が失敗しました。", error);
        });
      } catch (error) {
        this.log(signal.conversationId, "会話の合図の受け手が失敗しました。", error);
      }
    }
  }
  private log(id: string, message: string, error?: unknown): void {
    this.options.log(
      { conversationId: id, issueId: this.store.get(id)?.issueId ?? null },
      message,
      error,
    );
  }
  serial<T, E extends DeliveryError>(
    id: string,
    operation: () => Promise<Result<T, E>>,
    callerCancelled?: () => boolean,
  ): Promise<Result<T, E | OperationError>> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (this.acceptedDeliveries.has(id)) await this.waitForAcceptedDelivery(id);
        if (callerCancelled?.()) return err<T, OperationError>(unavailableRunnerError);
        return operation();
      })
      .catch((error: unknown) => {
        if (error instanceof InputRefused) return err<T, OperationError>(error.refusal);
        if (
          error instanceof WorktreeActivityBusy ||
          error instanceof ConversationWorkspaceChanged ||
          error instanceof ProjectRunBlocked
        )
          return err<T, OperationError>(conflict(error.message));
        this.log(id, "会話の操作に失敗しました。", error);
        return err<T, OperationError>({
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        });
      });
    this.operations.set(id, next);
    void next.finally(() => {
      if (this.operations.get(id) === next) this.operations.delete(id);
    });
    return next;
  }
  record(
    id: string,
    events: ConversationEvent[],
    before: () => void = () => {},
    unchanged: () => boolean = () => true,
    beforeCommit?: () => void,
  ): StoredEvent[] {
    const previous = this.store.get(id)?.runState;
    const recorded = this.store.transaction(() => {
      if (!unchanged()) return [];
      before();
      const records = events.flatMap((e) => {
        const record = this.store.append(id, e, this.options.clock.now());
        return record ? [record] : [];
      });
      beforeCommit?.();
      return records;
    });
    for (const event of recorded) {
      this.signal({ type: "event", conversationId: id, event });
      if (event.type === "stopped")
        this.signal({
          type: "stopped",
          conversationId: id,
          reason: event.payload.reason,
          ...(event.payload.previous_run_state
            ? { previousRunState: event.payload.previous_run_state }
            : {}),
        });
      if (
        event.type === "answer" ||
        event.type === "resumed" ||
        (event.type === "user_message" &&
          ["developer", "stock", "queued", "interrupt", "answer_text"].includes(
            event.payload.origin,
          ))
      )
        this.signal({
          type: "inputRecorded",
          conversationId: id,
          seq: event.seq,
          eventType: event.type,
        });
    }
    const current = this.store.get(id)?.runState;
    if (previous && current && previous !== current)
      this.signal({ type: "runStateChanged", conversationId: id, previous, current });
    if (recorded.some((event) => event.type === "answer")) this.partsChanged(id, ["answers"]);
    return recorded;
  }
  partsChanged(id: string, parts: ("queue" | "answers" | "stock" | "threads" | "draft")[]): void {
    this.signal({ type: "parts", conversationId: id, parts });
  }
  deliverQueue = deliverQueue.bind(this);
  start = start.bind(this);
  send = send.bind(this);
  private execution(c: Conversation, worktreeId: string | null): Execution {
    const opened = this.executions.get(c.id);
    if (opened) return opened;
    let execution: Execution | undefined;
    const session = this.options.agent.open({
      sessionId: c.sessionId ?? this.options.uuid(),
      resume: c.sessionId !== null,
      ...this.runOptions.build(c),
      context: { conversationId: c.id, projectId: c.projectId, issueId: c.issueId },
      onQuestion: (request) => this.question(c.id, execution, request),
      onPermission: (request) => this.askPermission(c.id, execution, request),
    });
    execution = {
      cwd: c.cwd,
      worktreeId,
      session,
      consuming: Promise.resolve(),
      ended: Promise.resolve(),
      end: () => {},
      intent: null,
      rate: null,
      assistantError: null,
      startSeq: 0,
      inputOrigin: "developer",
      reopening: null,
      streamEnded: false,
      turnActive: false,
    };
    this.executions.set(c.id, execution);
    return execution;
  }
  async deliver(
    id: string,
    input: SendInput,
    acceptance?: InputAcceptance,
    options: DeliveryOptions = {},
  ): Promise<Result<SendResult, OperationError>> {
    const c = options.newConversation ?? this.store.get(id);
    if (!c) throw new Error("会話がありません。");
    if (options.projectRun) {
      if (options.projectRun.projectId !== c.projectId)
        throw new Error("プロジェクトが一致しません。");
      return this.deliverWithProjectRun(id, input, acceptance, options);
    }
    const reservation = this.store.reserveProjectRun(c.projectId);
    let releaseAfterDelivery = false;
    try {
      const result = await this.deliverWithProjectRun(id, input, acceptance, options);
      if (options.afterAcceptance && result.isOk()) {
        releaseAfterDelivery = true;
        void this.waitForAcceptedDelivery(id)
          .finally(() => reservation.release())
          .catch((error: unknown) => this.log(id, "作業の予約を解除できませんでした。", error));
      }
      return result;
    } finally {
      if (!releaseAfterDelivery) reservation.release();
    }
  }
  private async deliverWithProjectRun(
    id: string,
    input: SendInput,
    acceptance: InputAcceptance | undefined,
    options: DeliveryOptions,
  ): Promise<Result<SendResult, OperationError>> {
    const { newConversation } = options;
    const prepare = () => {
      const includeQueued = !options.afterAcceptance && (options.includeQueued ?? true);
      const queued = includeQueued ? this.store.queue(id) : [];
      const inputs = [...queued, input];
      const text = inputs
        .map((entry) => entry.text)
        .filter((part) => part.length > 0)
        .join("\n\n");
      const imageIds = inputs.flatMap((entry) => entry.images);
      if (!text.length && !imageIds.length)
        return err<never, OperationError>({
          code: "invalid_input",
          message: "入力を確認してください。",
        });
      const images: LoadedImage[] = [];
      let missingImages = 0;
      for (const imageId of imageIds) {
        const image = this.options.images.read(id, imageId);
        if (image.isErr()) {
          if (!options.omitMissingImages || image.error.code !== "invalid_input")
            return err<never, OperationError>(image.error);
          missingImages += 1;
        } else images.push(image.value);
      }
      if (!text.length && !images.length)
        return err<never, OperationError>({
          code: "invalid_input",
          message:
            "画像が見つからないため、指示を届けられませんでした。画像を添付し直して、もう一度送ってください。",
        });
      const message = [options.prefix, text].filter(Boolean).join("\n\n");
      return ok({ includeQueued, queued, inputs, text: message, images, missingImages });
    };
    const check = () => {
      const refused = acceptance?.check?.();
      if (refused) return refused;
      const conversation = options.checkStage && this.store.get(id);
      return conversation
        ? this.runOptions.checkStart(conversation, options.checkStage === "owner")
        : null;
    };
    const preflight = check();
    if (preflight) return err(preflight);
    const initial = prepare();
    if (initial.isErr()) return err(initial.error);
    const active = this.executions.get(id);
    const previousIntent = active?.intent ?? null;
    const interruptBeforeAcceptance = options.interrupt && !options.afterAcceptance;
    const interruptedStart =
      interruptBeforeAcceptance && active && !turnHasEnded(active) ? active.startSeq : null;
    let retiredThroughSeq: number | undefined;
    const finishInterrupted = async (message: string): Promise<void> => {
      if (interruptedStart !== null && active)
        await this.recordInterruptedStop(id, active, interruptedStart, message, retiredThroughSeq);
    };
    const reject = async (error: OperationError): Promise<Result<never, OperationError>> => {
      await finishInterrupted(error.message);
      return err(error);
    };
    if (interruptBeforeAcceptance && active && !active.streamEnded) {
      try {
        await Promise.race([this.interrupt(id, "interrupt"), active.consuming]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI を停止できませんでした。";
        if (
          !turnHasEnded(active) &&
          active.startSeq === interruptedStart &&
          this.executions.get(id) === active
        ) {
          active.intent = previousIntent;
          active.refusedInterrupt = { startSeq: interruptedStart, message };
        }
        await finishInterrupted(message);
        throw error;
      }
      const refusal = check();
      if (refusal) return reject(refusal);
    }
    const withDeliveryWorkspace = <T>(operation: (worktreeId: string | null) => T) => {
      const workspace = acceptance?.workspace;
      if (!workspace) return this.store.withWorkspace(id, operation);
      return this.store.withWorktreeReservation((reservation) => {
        reservation.acquire([workspace.id]);
        return operation(this.store.get(id)?.worktreeId ?? null);
      });
    };
    const attemptDelivery = () =>
      withDeliveryWorkspace((worktreeId): Result<SendResult, OperationError> | Execution | null => {
        let refusal = check();
        if (refusal) return err(refusal);
        if (this.closing) return err(conflict());
        const c = this.store.get(id) ?? newConversation;
        if (!c) throw new Error("会話がありません。");
        const opened = this.executions.get(id);
        if (
          opened &&
          (opened.streamEnded ||
            opened.cwd !== (acceptance?.workspace?.path ?? c.cwd) ||
            opened.worktreeId !== (acceptance?.workspace?.id ?? worktreeId))
        )
          return opened;
        const prepared = prepare();
        if (prepared.isErr()) return err(prepared.error);
        const { includeQueued, queued, inputs, text, images, missingImages } = prepared.value;
        const hasStructuredComments = inputs.some((entry) => entry.timelineComments !== undefined);
        const legacyTexts = inputs
          .filter((entry) => entry.timelineComments === undefined && entry.text.length > 0)
          .map((entry) => entry.text);
        const event: ConversationEvent = {
          type: "user_message",
          payload: {
            text,
            images: images.map(({ path, mediaType }) => ({ path, media_type: mediaType })),
            origin: input.origin,
            ...(hasStructuredComments
              ? {
                  timeline_comments: inputs.flatMap((entry) => entry.timelineComments ?? []),
                  ...(legacyTexts.length ? { timeline_legacy_texts: legacyTexts } : {}),
                }
              : {}),
            client_ids: [
              ...queued.flatMap((q) => (q.clientId ? [q.clientId] : [])),
              ...(input.clientId ? [input.clientId] : []),
            ],
            queued_ids: queued.map((q) => q.id),
            client_receipts: [
              ...queued.flatMap((q) =>
                q.clientId
                  ? [
                      {
                        client_id: q.clientId,
                        result: "queued" as const,
                        queued_id: q.id,
                        received_at: q.createdAt,
                      },
                    ]
                  : [],
              ),
              ...(input.clientId
                ? [
                    {
                      client_id: input.clientId,
                      result: "delivered" as const,
                      received_at: this.options.clock.now(),
                    },
                  ]
                : []),
            ],
          },
        };
        const deferred: AcceptedInstruction | undefined = options.afterAcceptance
          ? {
              id: this.options.id(),
              conversationId: id,
              text,
              images: input.images,
              clientId: input.clientId ?? null,
              createdAt: this.options.clock.now(),
              ...(input.timelineComments === undefined
                ? {}
                : { timelineComments: input.timelineComments }),
            }
          : undefined;
        let execution: Execution | undefined;
        let openingError: { cause: unknown } | undefined;
        let resumeClosedAt: number | null = null;
        let records: StoredEvent[];
        try {
          records = this.record(
            id,
            [...(acceptance?.events ?? []), ...(deferred ? [] : [event])],
            () => {
              if (newConversation) this.store.create(newConversation);
              acceptance?.before?.();
              if (options.reopensAfterAcceptance)
                resumeClosedAt = this.store.get(id)?.closedAt ?? null;
              try {
                execution =
                  newConversation || acceptance?.workspace
                    ? this.store.withWorkspace(id, (actualId) =>
                        this.execution(this.store.get(id) ?? c, actualId),
                      )
                    : this.execution(c, worktreeId);
              } catch (error) {
                openingError = { cause: error };
                throw error;
              }
              if (deferred) this.store.stageAccepted(deferred);
              else if (includeQueued)
                this.store.dequeue(
                  id,
                  (this.store.get(id)?.lastSeq ?? 0) + (acceptance?.events.length ?? 0) + 1,
                );
            },
            () =>
              withDeliveryWorkspace((actualWorktreeId) => {
                const current = this.store.get(id);
                refusal = check();
                if (refusal !== null || this.closing) return false;
                if (newConversation) {
                  if (current) refusal = conflict();
                  return current === null;
                }
                return (
                  current?.cwd === c.cwd &&
                  actualWorktreeId === worktreeId &&
                  (!includeQueued ||
                    JSON.stringify(this.store.queue(id)) === JSON.stringify(queued))
                );
              }),
            () => {
              const rejected = acceptance?.checkBeforeCommit?.();
              if (rejected) throw new InputRefused(rejected);
            },
          );
        } catch (error) {
          if (!opened && execution) {
            this.executions.delete(id);
            try {
              execution.session.close();
            } catch (closeError) {
              this.log(id, "未受理の実行を閉じられませんでした。", closeError);
            }
          }
          if (error instanceof InputRefused) return err(error.refusal);
          if (openingError && !newConversation && options.recordOpeningFailure !== false)
            this.record(id, [
              {
                type: "stopped",
                payload: {
                  reason: "error",
                  detail:
                    openingError.cause instanceof Error
                      ? openingError.cause.message
                      : "AI の実行に失敗しました。",
                },
              },
            ]);
          throw error;
        }
        if (refusal) return err(refusal);
        if (!execution) return null;
        if (!opened) execution.consuming = this.consume(id, execution);
        const deliver = (activeExecution: Execution, record: StoredEvent) => {
          this.timers.cancel(id);
          activeExecution.rate = null;
          activeExecution.assistantError = null;
          activeExecution.intent = null;
          delete activeExecution.refusedInterrupt;
          activeExecution.startSeq = record.seq;
          activeExecution.turnActive = true;
          activeExecution.acceptedInputId = deferred?.id;
          activeExecution.inputOrigin = input.origin;
          activeExecution.reopening =
            resumeClosedAt === null
              ? null
              : {
                  closedAt: resumeClosedAt,
                  until:
                    record.createdAt +
                    (options.reopensAfterAcceptance === "stock"
                      ? RUNNER_IPC_TIMEOUT_MS + STOCK_SEND_SETTLEMENT_TIMEOUT_MS
                      : reopenWaitMs),
                };
          activeExecution.ended = new Promise((resolve) => {
            activeExecution.end = resolve;
          });
          activeExecution.session.send({
            text,
            images: images.map(({ data, mediaType }) => ({ data, mediaType })),
          });
          if (missingImages)
            this.options.notice(
              id,
              `画像 ${missingImages} 件が見つからないため、外して届けました`,
              "info",
            );
        };
        if (deferred) {
          this.deliverAccepted(
            id,
            execution,
            deferred.id,
            Boolean(opened && options.interrupt),
            event,
            deliver,
          );
          return ok({ result: "queued", queuedId: deferred.id });
        }
        if (queued.length)
          this.partsChanged(
            id,
            queued.some((entry) => entry.stockItemId) ? ["queue", "stock"] : ["queue"],
          );
        const record = records.at(-1);
        if (!record) throw new Error("指示を記録できません。");
        deliver(execution, record);
        return ok({ result: "delivered", seq: record.seq });
      });
    for (;;) {
      let result: ReturnType<typeof attemptDelivery>;
      try {
        result = attemptDelivery();
      } catch (error) {
        await finishInterrupted(
          error instanceof Error ? error.message : "指示を届けられませんでした。",
        );
        throw error;
      }
      if (result === null) continue;
      if (!("session" in result)) return result.isErr() ? reject(result.error) : result;
      try {
        result.session.close();
      } catch (error) {
        if (!result.streamEnded) throw error;
        this.log(id, "終了した実行を閉じられませんでした。", error);
      }
      await result.consuming;
      if (this.executions.get(id) === result) {
        const refusal = check();
        if (refusal) return reject(refusal);
        if (result === active && result.startSeq === interruptedStart)
          retiredThroughSeq = this.store.get(id)?.lastSeq;
        this.executions.delete(id);
      }
    }
  }
  private async recordInterruptedStop(
    id: string,
    execution: Execution,
    startSeq: number,
    message: string,
    retiredThroughSeq?: number,
  ): Promise<void> {
    if (!turnHasEnded(execution)) return;
    try {
      const stopped = await this.retryConversationWrite(() =>
        this.record(
          id,
          [{ type: "stopped", payload: { reason: "error", detail: message } }],
          undefined,
          () => {
            const current = this.store.get(id);
            const running = this.executions.get(id);
            return (
              !this.closing &&
              current?.closedAt === null &&
              activeStates.includes(current.runState) &&
              execution.startSeq === startSeq &&
              turnHasEnded(execution) &&
              (running === execution ||
                (running === undefined && current.lastSeq === retiredThroughSeq))
            );
          },
        ),
      );
      if (stopped.length) this.options.notice(id, message, "error");
    } catch (error) {
      this.log(id, "割り込んだ番の停止を記録できませんでした。", error);
    }
  }
  private deliverAccepted(
    id: string,
    execution: Execution,
    instructionId: string,
    interrupt: boolean,
    event: ConversationEvent,
    deliver: (execution: Execution, record: StoredEvent) => void,
  ) {
    let active = execution;
    this.trackAcceptedDelivery(id, instructionId, async () => {
      try {
        if (interrupt) {
          await Promise.race([this.interrupt(id, "interrupt"), execution.consuming]);
          if (execution.turnActive) throw new Error("元の番の終了を確認できませんでした。");
          execution.session.close();
          await execution.consuming;
          this.executions.delete(id);
        } else if (execution.streamEnded) {
          throw new Error("AI との接続が切れました。");
        }
        this.store.withWorkspace(id, (worktreeId) => {
          const conversation = this.store.get(id);
          if (
            worktreeId !== execution.worktreeId ||
            conversation?.cwd !== execution.cwd ||
            conversation.closedAt !== null
          )
            throw new ConversationWorkspaceChanged();
          if (interrupt) {
            active = this.execution(conversation, worktreeId);
            active.consuming = this.consume(id, active);
          }
          const records = this.record(id, [event], () => {
            if (!this.store.removeAccepted(instructionId))
              throw new Error("受理済みの指示がありません。");
            if (interrupt)
              this.store.clearQuestionsBefore(id, (this.store.get(id)?.lastSeq ?? 0) + 1);
          });
          if (interrupt) this.partsChanged(id, ["answers"]);
          const record = records.at(-1);
          if (!record) throw new Error("指示を記録できません。");
          deliver(active, record);
        });
      } catch (error) {
        await this.failAcceptedDelivery(
          id,
          active,
          instructionId,
          "差し戻しの指摘を AI に届けられませんでした。会話を開いて、もう一度指示してください。",
          error,
        );
      }
    });
  }
  private trackAcceptedDelivery(id: string, instructionId: string, action: () => Promise<void>) {
    const job = Promise.resolve()
      .then(action)
      .catch((error: unknown) => this.log(id, "差し戻しの失敗を記録できませんでした。", error))
      .finally(() => {
        if (this.acceptedDeliveries.get(id)?.job === job) this.acceptedDeliveries.delete(id);
      });
    this.acceptedDeliveries.set(id, { instructionId, job });
  }
  private async waitForAcceptedDelivery(id: string): Promise<void> {
    let delivery = this.acceptedDeliveries.get(id);
    while (delivery) {
      await delivery.job;
      delivery = this.acceptedDeliveries.get(id);
    }
  }
  drainAcceptedDeliveries(): Promise<unknown> {
    return Promise.all(
      [...this.acceptedDeliveries.keys()].map((id) => this.waitForAcceptedDelivery(id)),
    );
  }
  private async failAcceptedDelivery(
    id: string,
    execution: Execution,
    instructionId: string,
    message: string,
    error: unknown,
  ) {
    if (this.executions.get(id) === execution) {
      execution.turnActive = false;
      this.executions.delete(id);
      execution.end();
      try {
        execution.session.close();
      } catch (closeError) {
        this.log(id, "実行を閉じられませんでした。", closeError);
      }
    }
    const stopped = {
      type: "stopped" as const,
      payload: { reason: "error" as const, detail: message },
    };
    const restored = await this.retryConversationWrite(() => {
      const current = this.store.get(id);
      if (this.closing || !current || current.closedAt !== null || this.executions.has(id))
        return null;
      let restored = false;
      this.record(id, current.runState === "failed" ? [] : [stopped], () => {
        restored = this.store.recoverAccepted(instructionId);
      });
      return restored;
    });
    if (restored === null) return;
    if (restored) this.partsChanged(id, ["queue"]);
    this.log(id, message, error);
    this.options.notice(id, message, "error");
  }
  private async retryConversationWrite<T>(write: () => T): Promise<T> {
    for (;;) {
      try {
        return write();
      } catch (error) {
        if (!(error instanceof ConversationWriteBusy)) throw error;
        await new Promise<void>((resolve) => {
          this.options.clock.setTimeout(resolve, 100);
        });
      }
    }
  }
  private failExecution(id: string, execution: Execution, message: string) {
    if (this.executions.get(id) !== execution) return;
    try {
      execution.session.close();
    } catch (error) {
      this.log(id, "実行を閉じられませんでした。", error);
      return;
    }
    execution.end();
    this.executions.delete(id);
    this.record(id, [{ type: "stopped", payload: { reason: "error", detail: message } }]);
  }
  prepareStop(id: string, intent: "user" | "dependency_withdrawn" = "user") {
    const execution = this.executions.get(id);
    const accepted = this.acceptedDeliveries.get(id)?.instructionId;
    const seq = execution?.startSeq;
    const last = this.store.get(id)?.lastSeq;
    return () =>
      this.stop(
        id,
        () => {
          const current = this.executions.get(id);
          return accepted
            ? current?.acceptedInputId === accepted
            : execution === current &&
                (current ? current.startSeq === seq : this.store.get(id)?.lastSeq === last);
        },
        () => {
          const current = this.executions.get(id);
          if (current)
            this.failExecution(id, current, "AI の番を停止できなかったため実行を閉じました。");
        },
        undefined,
        intent,
      );
  }
  private async consume(id: string, execution: Execution): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      for await (const output of execution.session.output) await this.output(id, execution, output);
    } catch (error) {
      failure = { error };
    } finally {
      execution.streamEnded = true;
      execution.end();
    }
    if (this.executions.get(id) !== execution) return;
    const refusedInterrupt = execution.refusedInterrupt;
    if (refusedInterrupt && refusedInterrupt.startSeq === execution.startSeq) {
      delete execution.refusedInterrupt;
      void this.serial(id, async () => {
        await this.recordInterruptedStop(
          id,
          execution,
          refusedInterrupt.startSeq,
          refusedInterrupt.message,
        );
        return ok(undefined);
      });
      return;
    }
    const instructionId = execution.acceptedInputId;
    if (instructionId && execution.turnActive && execution.intent === null && !this.closing) {
      const prior = this.acceptedDeliveries.get(id)?.job;
      this.trackAcceptedDelivery(id, instructionId, async () => {
        if (prior) await prior;
        if (
          this.executions.get(id) !== execution ||
          execution.acceptedInputId !== instructionId ||
          !execution.turnActive ||
          execution.intent !== null ||
          this.closing
        )
          return;
        const message = "差し戻しの後に AI との接続が切れました。";
        await this.failAcceptedDelivery(id, execution, instructionId, message, failure?.error);
      });
      return;
    }
    if (!failure) return;
    const { error } = failure;
    if (!this.closing)
      this.record(id, [
        {
          type: "stopped",
          payload: {
            reason: "error",
            detail: error instanceof Error ? error.message : "AI の実行に失敗しました。",
          },
        },
      ]);
    this.log(id, "AI の実行に失敗しました。", error);
    execution.session.close();
    this.executions.delete(id);
  }
  private async output(id: string, execution: Execution, output: AgentOutput): Promise<void> {
    if (this.executions.get(id) !== execution) return;
    if (output.kind === "init") {
      this.store.transaction(() => this.store.session(id, output.sessionId));
      const projectId = this.store.get(id)?.projectId;
      if (projectId) this.options.commands?.remember(id, projectId, output.commands);
      return;
    }
    if (output.kind === "text_delta") {
      if (output.parentToolUseId === null)
        this.signal({ type: "delta", conversationId: id, text: output.text });
      return;
    }
    if (output.kind === "assistant_error") {
      execution.assistantError = output.error;
      return;
    }
    if (output.kind === "rate_limit") {
      execution.rate = output;
      recordRateLimit(this.store, output, this.options.clock.now());
      this.log(id, JSON.stringify(output.raw));
      return;
    }
    if (output.kind === "turn_end") {
      if (this.closing) {
        execution.end();
        return;
      }
      const stop = classifyStop(output, execution.rate, execution.assistantError, execution.intent);
      const records = this.record(id, [
        ...outputEvents(output),
        ...(stop.stopped ? [{ type: "stopped" as const, payload: stop.stopped }] : []),
      ]);
      const end = records.find((e) => e.type === "turn_end");
      if (end)
        this.signal({
          type: "turnEnded",
          conversationId: id,
          startSeq: execution.startSeq,
          endSeq: end.seq,
          subtype: output.subtype,
        });
      this.log(
        id,
        `番が終わりました: ${output.subtype}; cost_usd=${output.costUsd}; duration_ms=${output.durationMs}`,
      );
      const intent = execution.intent;
      const finishedSeq = execution.startSeq;
      const reopening = execution.reopening;
      execution.turnActive = false;
      execution.end();
      if (stop.state === "usage_limited") {
        const stopped = records.find((record) => record.type === "stopped");
        this.scheduleUsageResume(
          id,
          reopening && stopped ? { ...reopening, stopSeq: stopped.seq } : undefined,
        );
      }
      if (
        output.subtype === "success" &&
        !stop.stopped &&
        intent === null &&
        this.store.queue(id).length
      )
        void this.serial(id, async () => {
          const current = this.store.get(id);
          if (
            !this.closing &&
            !this.releases.has(id) &&
            this.executions.get(id) === execution &&
            execution.startSeq === finishedSeq &&
            current?.runState === "idle" &&
            (current.closedAt === null || this.reopenWait(current, reopening) > 0) &&
            this.store.queue(id).length
          ) {
            const result = await this.deliver(
              id,
              { text: "", images: [], origin: "queued" },
              undefined,
              { omitMissingImages: true, checkStage: "accepted" },
            );
            if (result.isErr()) {
              this.log(id, "預かった指示を届けられませんでした。", result.error.message);
              this.options.notice(id, result.error.message, "error");
            }
            return result.map(() => undefined);
          }
          return ok(undefined);
        });
      return;
    }
    if (output.kind === "assistant_text" && execution.inputOrigin !== "answer_text") {
      this.store.transaction(() => this.store.clearQuestionsBefore(id, execution.startSeq));
      this.partsChanged(id, ["answers"]);
    }
    this.record(id, outputEvents(output));
  }
  async commands(id: string): Promise<{ name: string; description: string }[]> {
    const execution = this.executions.get(id);
    const projectId = this.store.get(id)?.projectId;
    if (!projectId) return [];
    if (execution) {
      const commands = await execution.session.commands();
      this.options.commands?.remember(id, projectId, commands);
      return commands;
    }
    return this.options.commands?.read(id, projectId) ?? [];
  }
  private question(
    id: string,
    execution: Execution | undefined,
    request: QuestionRequest,
  ): Promise<Record<string, string>> {
    if (
      !execution ||
      this.executions.get(id) !== execution ||
      !execution.turnActive ||
      execution.intent !== null
    )
      return Promise.reject(new Error("この番は終了しました。"));
    this.record(id, [
      {
        type: "question",
        payload: { request_id: request.requestId, questions: request.questions },
      },
    ]);
    return new Promise((resolve, reject) => {
      execution.question = { request, resolve, reject };
    });
  }
  private askPermission(
    id: string,
    execution: Execution | undefined,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (
      !execution ||
      this.executions.get(id) !== execution ||
      !execution.turnActive ||
      execution.intent !== null
    )
      return Promise.resolve({ behavior: "deny", message: "この番は終了しました。" });
    this.record(id, [
      {
        type: "permission_request",
        payload: {
          request_id: request.requestId,
          tool_name: request.toolName,
          input: request.input,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.blockedPath === undefined ? {} : { blocked_path: request.blockedPath }),
        },
      },
    ]);
    return new Promise((resolve) => {
      execution.permission = { request, resolve };
    });
  }
  async interrupt(id: string, intent: StopIntent): Promise<void> {
    const execution = this.executions.get(id);
    if (!execution) return;
    execution.intent = intent;
    execution.question?.reject(new Error("開発者が割り込んだ"));
    delete execution.question;
    execution.permission?.resolve({ behavior: "deny", message: "開発者が割り込んだ" });
    delete execution.permission;
    await execution.session.interrupt();
    await execution.ended;
  }
  stop = stop.bind(this);
  resume = resume.bind(this);
  fork = fork.bind(this);
  answer = answer.bind(this);
  permission = permission.bind(this);
  release = release.bind(this);
  private reopenWait(c: Conversation, reopening: Reopening | null): number {
    return reopening && c.closedAt === reopening.closedAt
      ? Math.max(0, reopening.until - this.options.clock.now())
      : 0;
  }
  scheduleUsageResume(id: string, reopening?: Reopening & { stopSeq: number }): void {
    const c = this.store.get(id);
    if (!c || c.runState !== "usage_limited" || this.store.isUsageTimerRetired(id, c.lastSeq))
      return;
    if (c.closedAt !== null && this.reopenWait(c, reopening ?? null) === 0) return;
    const stopSeq = reopening?.stopSeq ?? this.store.latestStopSeq(id);
    const sameStop = () => this.store.latestStopSeq(id) === stopSeq;
    this.timers.schedule(
      id,
      c.resetsAt,
      async (current) => {
        let projectBusy = false;
        await this.resume(id, "usage_limit", {
          usageTimerCurrent: () => current() && sameStop(),
          onProjectBusy: () => {
            projectBusy = true;
          },
        });
        const latest = this.store.get(id);
        if (projectBusy && latest?.runState === "usage_limited" && sameStop()) return 250;
      },
      reopening
        ? () => {
            if (this.closing || this.releases.has(id)) return null;
            const latest = this.store.get(id);
            if (latest?.runState !== "usage_limited" || !sameStop()) return null;
            const remaining = this.reopenWait(latest, reopening);
            return remaining > 0 ? Math.min(remaining, 100) : null;
          }
        : undefined,
    );
  }
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.timers.clear();
    this.releases.clear();
    await Promise.all(
      [...this.executions].map(async ([id, execution]) => {
        if (activeStates.includes(this.store.get(id)?.runState ?? "idle"))
          await this.interrupt(id, "user");
        execution.session.close();
        await execution.consuming;
      }),
    );
    this.executions.clear();
  }
}
