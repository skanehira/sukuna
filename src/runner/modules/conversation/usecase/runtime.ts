import { RunOptions } from "./run-options";
import type { CommandCache } from "../domain/agent-port";
import { ConversationWorkspaceChanged } from "../domain/conversation-store";
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
import type { Conversation, ConversationStore, SendResult } from "../domain/conversation-store";
import { classifyStop, type RateLimit } from "../domain/stop-reason";
import { outputEvents } from "../domain/event-mapping";
import type { ConversationEvent, StoredEvent, Origin, RunState } from "../../../../shared/events";
import { AppToolRegistry } from "./app-tool-registry";
import { UsageLimitTimer } from "./usage-limit-timer";
import { recordRateLimit } from "./record-rate-limit";
import type { TimelineInputComment } from "../../../../shared/progress/schema";

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
  | { type: "parts"; parts: ("queue" | "answers" | "stock" | "threads")[] }
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
};
export type InputAcceptance = {
  events: ConversationEvent[];
  before?: () => void;
  check?: () => OperationError | null;
  checkBeforeCommit?: () => OperationError | null;
};
class InputRefused extends Error {
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
  intent: "user" | "interrupt" | null;
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
};
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
  ): Promise<Result<T, E | OperationError>> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.then(operation).catch((error: unknown) => {
      if (error instanceof WorktreeActivityBusy || error instanceof ConversationWorkspaceChanged)
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
  partsChanged(id: string, parts: ("queue" | "answers" | "stock" | "threads")[]): void {
    this.signal({ type: "parts", conversationId: id, parts });
  }
  deliverQueue = deliverQueue.bind(this);
  start = start.bind(this);
  send = send.bind(this);
  private execution(c: Conversation, worktreeId: string | null): Execution {
    const opened = this.executions.get(c.id);
    if (opened) return opened;
    const session = this.options.agent.open({
      sessionId: c.sessionId ?? this.options.uuid(),
      resume: c.sessionId !== null,
      ...this.runOptions.build(c),
      context: { conversationId: c.id, projectId: c.projectId, issueId: c.issueId },
      onQuestion: (request) => this.question(c.id, request),
      onPermission: (request) => this.askPermission(c.id, request),
    });
    const execution: Execution = {
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
    };
    this.executions.set(c.id, execution);
    return execution;
  }
  async deliver(
    id: string,
    input: SendInput,
    acceptance?: InputAcceptance,
    options: {
      includeQueued?: boolean;
      interrupt?: boolean;
      omitMissingImages?: boolean;
      reopensAfterAcceptance?: boolean;
      newConversation?: Conversation;
      recordOpeningFailure?: boolean;
    } = {},
  ): Promise<Result<SendResult, OperationError>> {
    const { newConversation } = options;
    if (!newConversation && !this.store.get(id)) throw new Error("会話がありません。");
    const prepare = () => {
      const includeQueued = options.includeQueued ?? true;
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
      return ok({ includeQueued, queued, inputs, text, images, missingImages });
    };
    const initial = prepare();
    if (initial.isErr()) return err(initial.error);
    if (options.interrupt) await this.interrupt(id, "interrupt");
    const reject = (error: OperationError): Result<never, OperationError> => {
      if (options.interrupt) {
        this.record(id, [{ type: "stopped", payload: { reason: "error", detail: error.message } }]);
        this.options.notice(id, error.message, "error");
      }
      return err(error);
    };
    for (;;) {
      const result = this.store.withWorkspace(
        id,
        (worktreeId): Result<SendResult, OperationError> | Execution | null => {
          let refusal = acceptance?.check?.() ?? null;
          if (refusal) return err(refusal);
          if (this.closing) return err(conflict());
          const c = this.store.get(id) ?? newConversation;
          if (!c) throw new Error("会話がありません。");
          const opened = this.executions.get(id);
          if (opened && (opened.cwd !== c.cwd || opened.worktreeId !== worktreeId)) return opened;
          const prepared = prepare();
          if (prepared.isErr()) return reject(prepared.error);
          const { includeQueued, queued, inputs, text, images, missingImages } = prepared.value;
          const hasStructuredComments = inputs.some(
            (entry) => entry.timelineComments !== undefined,
          );
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
          let execution: Execution | undefined;
          let openingError: { cause: unknown } | undefined;
          let resumeClosedAt: number | null = null;
          let records: StoredEvent[];
          try {
            records = this.record(
              id,
              [...(acceptance?.events ?? []), event],
              () => {
                if (newConversation) this.store.create(newConversation);
                acceptance?.before?.();
                if (options.reopensAfterAcceptance)
                  resumeClosedAt = this.store.get(id)?.closedAt ?? null;
                try {
                  execution = newConversation
                    ? this.store.withWorkspace(id, (actualId) => this.execution(c, actualId))
                    : this.execution(c, worktreeId);
                } catch (error) {
                  openingError = { cause: error };
                  throw error;
                }
                if (includeQueued)
                  this.store.dequeue(
                    id,
                    (this.store.get(id)?.lastSeq ?? 0) + (acceptance?.events.length ?? 0) + 1,
                  );
              },
              () =>
                this.store.withWorkspace(id, (actualWorktreeId) => {
                  const current = this.store.get(id);
                  refusal = acceptance?.check?.() ?? null;
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
          if (!records.length) return null;
          if (!execution) throw new Error("実行がありません。");
          const activeExecution = execution;
          if (!opened) activeExecution.consuming = this.consume(id, activeExecution);
          if (queued.length)
            this.partsChanged(
              id,
              queued.some((entry) => entry.stockItemId) ? ["queue", "stock"] : ["queue"],
            );
          const record = records.at(-1);
          if (!record) throw new Error("指示を記録できません。");
          this.timers.cancel(id);
          activeExecution.rate = null;
          activeExecution.assistantError = null;
          activeExecution.intent = null;
          activeExecution.startSeq = record.seq;
          activeExecution.inputOrigin = input.origin;
          activeExecution.reopening =
            resumeClosedAt === null
              ? null
              : {
                  closedAt: resumeClosedAt,
                  until:
                    record.createdAt +
                    (input.origin === "stock"
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
          return ok({ result: "delivered", seq: record.seq });
        },
      );
      if (result === null) continue;
      if (!("session" in result)) return result;
      result.session.close();
      await result.consuming;
      if (this.executions.get(id) === result) this.executions.delete(id);
    }
  }
  private async consume(id: string, execution: Execution): Promise<void> {
    try {
      for await (const output of execution.session.output) await this.output(id, execution, output);
    } catch (error) {
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
      execution.end();
      execution.session.close();
      this.executions.delete(id);
    }
  }
  private async output(id: string, execution: Execution, output: AgentOutput): Promise<void> {
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
              { omitMissingImages: true },
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
  private question(id: string, request: QuestionRequest): Promise<Record<string, string>> {
    this.record(id, [
      {
        type: "question",
        payload: { request_id: request.requestId, questions: request.questions },
      },
    ]);
    return new Promise((resolve, reject) => {
      const execution = this.executions.get(id);
      if (!execution) {
        reject(new Error("実行がありません。"));
        return;
      }
      execution.question = { request, resolve, reject };
    });
  }
  private askPermission(id: string, request: PermissionRequest): Promise<PermissionDecision> {
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
      const execution = this.executions.get(id);
      if (execution) execution.permission = { request, resolve };
    });
  }
  async interrupt(id: string, intent: "user" | "interrupt"): Promise<void> {
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
    if (!c || c.runState !== "usage_limited") return;
    if (c.closedAt !== null && this.reopenWait(c, reopening ?? null) === 0) return;
    const sameStop = () => !reopening || this.store.latestStopSeq(id) === reopening.stopSeq;
    this.timers.schedule(
      id,
      c.resetsAt,
      async (current) => {
        await this.resume(id, "usage_limit", { usageTimerCurrent: () => current() && sameStop() });
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
