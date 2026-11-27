import { deliverQueue } from "./deliver-queue";
import { start } from "./start";
import { send } from "./send";
import { stop } from "./stop";
import { resume } from "./resume";
import { fork } from "./fork";
import { answer } from "./answers";
import { permission } from "./permissions";
import { release } from "./release";
import { err, ok, type Result } from "neverthrow";
import type {
  AgentPort,
  AgentSession,
  AgentOutput,
  QuestionRequest,
  PermissionRequest,
  PermissionDecision,
} from "../domain/agent-port";
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
  code: "conflict" | "not_found" | "internal" | "invalid_input";
  message: string;
};
export type RuntimeSignal = { conversationId: string } & (
  | { type: "event"; event: StoredEvent }
  | { type: "turnEnded"; startSeq: number; endSeq: number; subtype: string }
  | { type: "runStateChanged"; previous: RunState; current: RunState }
  | { type: "stopped"; reason: string; previousRunState?: RunState }
  | { type: "inputRecorded"; seq: number; eventType: string }
  | { type: "delta"; text: string }
  | { type: "parts"; parts: ("queue" | "answers")[] }
);
export type RuntimeOptions = {
  store: ConversationStore;
  agent: AgentPort;
  clock: Clock;
  id: () => string;
  uuid: () => string;
  canResume?: (conversation: Conversation) => Promise<boolean>;
  log: (
    context: { conversationId: string; issueId: string | null },
    message: string,
    error?: unknown,
  ) => void;
  notice: (conversationId: string, message: string) => void;
  tools?: AppToolRegistry;
};
export type SendInput = {
  text: string;
  images: string[];
  clientId?: string;
  interrupt?: boolean;
  origin: Origin;
  timelineComments?: TimelineInputComment[];
};
export type InputAcceptance = { events: ConversationEvent[]; before: () => void };
type Execution = {
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
};
export const activeStates: RunState[] = ["working", "waiting_answer", "waiting_permission"];
export const conflict = (
  message = "会話の状態が変わりました。もう一度操作してください。",
): OperationError => ({ code: "conflict", message });
export class ConversationRuntime {
  readonly store: ConversationStore;
  readonly tools: AppToolRegistry;
  readonly timers: UsageLimitTimer;
  executions = new Map<string, Execution>();
  private operations = new Map<string, Promise<unknown>>();
  private projectCommands = new Map<string, { name: string; description: string }[]>();
  private listeners = new Set<(signal: RuntimeSignal) => void | Promise<void>>();
  closing = false;
  options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = options;
    this.store = options.store;
    this.tools = options.tools ?? new AppToolRegistry();
    this.timers = new UsageLimitTimer(options.clock);
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
  serial<T>(
    id: string,
    operation: () => Promise<Result<T, OperationError>>,
  ): Promise<Result<T, OperationError>> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.then(operation).catch((error: unknown) => {
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
  record(id: string, events: ConversationEvent[], before: () => void = () => {}): StoredEvent[] {
    const previous = this.store.get(id)?.runState;
    const recorded = this.store.transaction(() => {
      before();
      return events.flatMap((e) => {
        const record = this.store.append(id, e, this.options.clock.now());
        return record ? [record] : [];
      });
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
  partsChanged(id: string, parts: ("queue" | "answers")[]): void {
    this.signal({ type: "parts", conversationId: id, parts });
  }
  deliverQueue = deliverQueue.bind(this);
  start = start.bind(this);
  send = send.bind(this);
  private execution(c: Conversation): Execution {
    const opened = this.executions.get(c.id);
    if (opened) return opened;
    const session = this.options.agent.open({
      sessionId: c.sessionId ?? this.options.uuid(),
      resume: c.sessionId !== null,
      cwd: c.cwd,
      model: null,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "",
      appTools: this.tools.all(),
      context: { conversationId: c.id, projectId: c.projectId, issueId: c.issueId },
      onQuestion: (request) => this.question(c.id, request),
      onPermission: (request) => this.askPermission(c.id, request),
    });
    const execution: Execution = {
      session,
      consuming: Promise.resolve(),
      ended: Promise.resolve(),
      end: () => {},
      intent: null,
      rate: null,
      assistantError: null,
      startSeq: 0,
      inputOrigin: "developer",
    };
    this.executions.set(c.id, execution);
    execution.consuming = this.consume(c.id, execution);
    return execution;
  }
  deliver(
    id: string,
    input: SendInput,
    acceptance?: InputAcceptance,
    includeQueued = true,
  ): SendResult {
    const c = this.store.get(id);
    if (!c) throw new Error("会話がありません。");
    let execution: Execution;
    try {
      execution = this.execution(c);
    } catch (error) {
      this.record(id, [
        {
          type: "stopped",
          payload: {
            reason: "error",
            detail: error instanceof Error ? error.message : "AI の実行に失敗しました。",
          },
        },
      ]);
      throw error;
    }
    const queued = includeQueued ? this.store.queue(id) : [];
    const inputs = [...queued, input];
    const hasStructuredComments = inputs.some((entry) => entry.timelineComments !== undefined);
    const legacyTexts = inputs
      .filter((entry) => entry.timelineComments === undefined && entry.text.length > 0)
      .map((entry) => entry.text);
    const text = [...queued.map((q) => q.text), input.text]
      .filter((s) => s.length > 0)
      .join("\n\n");
    const event: ConversationEvent = {
      type: "user_message",
      payload: {
        text,
        images: [],
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
    const records = this.record(id, [...(acceptance?.events ?? []), event], () => {
      acceptance?.before();
      if (includeQueued) this.store.dequeue(id);
    });
    if (queued.length) this.partsChanged(id, ["queue"]);
    const record = records.at(-1);
    if (!record) throw new Error("指示を記録できません。");
    this.timers.cancel(id);
    execution.rate = null;
    execution.assistantError = null;
    execution.intent = null;
    execution.startSeq = record.seq;
    execution.inputOrigin = input.origin;
    execution.ended = new Promise((resolve) => {
      execution.end = resolve;
    });
    execution.session.send({ text, images: [] });
    return { result: "delivered", seq: record.seq };
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
      if (projectId) this.projectCommands.set(projectId, output.commands);
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
      execution.end();
      if (stop.state === "usage_limited") this.scheduleUsageResume(id);
      if (
        output.subtype === "success" &&
        !stop.stopped &&
        intent === null &&
        this.store.queue(id).length
      )
        void this.serial(id, () => {
          const state = this.store.get(id)?.runState;
          if (!this.closing && state === "idle" && this.store.queue(id).length)
            this.deliver(id, { text: "", images: [], origin: "queued" });
          return Promise.resolve(ok(undefined));
        });
      return;
    }
    if (output.kind === "assistant_text" && execution.inputOrigin !== "answer_text") {
      this.store.transaction(() => this.store.clearStaleQuestions(id));
      this.partsChanged(id, ["answers"]);
    }
    this.record(id, outputEvents(output));
  }
  async commands(id: string): Promise<{ name: string; description: string }[]> {
    const execution = this.executions.get(id);
    if (execution) return execution.session.commands();
    const projectId = this.store.get(id)?.projectId;
    return projectId ? (this.projectCommands.get(projectId) ?? []) : [];
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
  scheduleUsageResume(id: string): void {
    const c = this.store.get(id);
    if (!c || c.closedAt !== null || c.runState !== "usage_limited") return;
    this.timers.schedule(id, c.resetsAt, async () => {
      const current = this.store.get(id);
      if (current?.runState === "usage_limited" && current.closedAt === null && !this.closing)
        await this.resume(id, "usage_limit");
    });
  }
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.timers.clear();
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
