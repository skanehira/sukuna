import type { ActionInfo } from "../../buffer/keymap/registry";
import {
  conversationAction,
  conversationActions,
  conversationCommands,
  timelineStopAction,
} from "./keymap";
import {
  draftReceipt,
  sameDraftReceipt,
  type ConversationMessage,
} from "../../../shared/conversation/api";
import type { ChangeDesc } from "@codemirror/state";
import {
  commentsFromAnchors,
  hasUnlocatedEdits,
  joinDraftContent,
  queueDraftContent,
  unlocatedConsultationNotice,
} from "../../../shared/progress/draft";
import { consultationContent, mapTimelineAnchors, replaceRange } from "./timeline-draft";
import { consultationPrefix, continueWork } from "../work-actions";
import type { Answers } from "../../../shared/events";
import { eventSchema } from "../../../shared/events";
import type { ServerMessage } from "../../../shared/ws";
import type { BufferHandle } from "../../buffer/Buffer";
import type { BufferController, PromptSpec } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import { canPlaceCursor } from "../../buffer/no-cursor";
import type { WorkMonitor } from "./work-monitor";
import type { RecapSession } from "../recap/session";
import { DraftSync, sameDraftContent } from "./draft-sync";
import {
  appendCancelledDraft,
  mapCancelledDraft,
  ownsCancelledDraft,
  removeCancelledDraft,
  type CancelledDraft,
} from "./queue-undo";
import { ConversationApiError } from "./api";
import { eventLines, stoppedText } from "./lines";
import type {
  ConversationApi,
  DraftContent,
  DraftRequest,
  Event,
  QueueItem,
  Snapshot,
} from "./types";

export type ConversationEnvironment = {
  clientId: string;
  id(): string;
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
};
type QuestionEvent = Extract<Event, { type: "question" }>;
type Block = { event: Event; lines: LineInfo[] };
type UndoRequest = { message: ConversationMessage; local: DraftSync };
type DeferredDraftSave = {
  local: DraftSync;
  expected?: NonNullable<Snapshot["draft"]>;
  conflicted: boolean;
  saving?: Promise<boolean>;
  pending?: DraftRequest;
  queued?: boolean;
};
type QueueUndo = { item: QueueItem; draft: CancelledDraft | null; pending?: UndoRequest };
const undoPending =
  "預けた指示を戻しています。対象の編集や送信は、復帰の結果が出てから行ってください。";
const undoConflict = "戻した指示を書きかけの中で確認できません。書きかけはそのまま残しました。";
export class ConversationSession {
  recap?: RecapSession;
  monitor?: WorkMonitor;
  private activeMonitor?: WorkMonitor;
  unreadSeq: number | null = null;
  private tailLines: Record<string, LineInfo[]> = {};
  private state: { data: Snapshot | null; version: number };
  private listeners = new Set<() => void>();
  private handle: BufferHandle | null = null;
  private head: LineInfo[] = [];
  private footer: LineInfo[] = [];
  private blocks: Block[] = [];
  private events: Event[] = [];
  private contiguousSeq = 0;
  private pendingEvents = new Map<number, Event>();
  private question: QuestionEvent | null = null;
  private reply = "";
  private removers: (() => void)[] = [];
  private draft: DraftSync;
  private nextFetch = 0;
  private appliedFetch = 0;
  private finishingDraft = false;
  private readonly draftWrites = new Set<Promise<boolean>>();
  private cancelSave: (() => void) | null = null;
  private messageId: string | null = null;
  private undo: QueueUndo | null = null;
  private deferredDraftSave: DeferredDraftSave | null = null;
  private queueOperation = false;
  private queueEditing: QueueItem | null = null;
  private online = true;
  private connected = false;
  readonly id: string;
  readonly api: ConversationApi;
  readonly controller: BufferController;
  private env: ConversationEnvironment;
  private readonly questionRemovers: (() => void)[] = [];
  private readonly view: "conversation" | "stock-thread";
  constructor(
    id: string,
    api: ConversationApi,
    controller: BufferController,
    env: ConversationEnvironment,
    {
      initial,
      view = "conversation",
    }: { initial?: Snapshot; view?: "conversation" | "stock-thread" } = {},
  ) {
    this.id = id;
    this.api = api;
    this.controller = controller;
    this.env = env;
    this.state = { data: initial ?? null, version: 0 };
    this.draft = new DraftSync(env.clientId, initial?.draft ?? null);
    this.view = view;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(): void {
    this.state = { ...this.state, version: this.state.version + 1 };
    this.listeners.forEach((listener) => listener());
  }
  async load(): Promise<string> {
    await this.refresh();
    let after = this.contiguousSeq;
    let more = true;
    while (more) {
      const page = await this.api.events(this.id, after);
      for (const event of [...page.events].sort((a, b) => a.seq - b.seq)) this.receiveEvent(event);
      more = page.hasMore;
      const next = page.events.at(-1)?.seq ?? after;
      if (more && next <= after) throw new Error("会話の続きが読み込めませんでした");
      after = next;
    }
    this.refreshTail();
    this.recap?.loaded(this.state.data!, this.events);
    (this.activeMonitor ?? this.monitor)?.loaded();
    this.emit();
    return this.id;
  }
  private adopt(data: Snapshot, preserveDraft = false, readVersion?: number): void {
    this.state = { ...this.state, data };
    const result =
      preserveDraft || this.undo?.pending
        ? { replaced: false, notice: null }
        : this.draft.receive(data.draft, readVersion);
    if (result.notice) this.controller.notify(result.notice);
    this.syncDraftPrompt({ replaceText: result.replaced });
    this.refreshTail();
    this.emit();
  }
  async refresh(preserveDraft = false, current?: () => boolean): Promise<void> {
    const request = ++this.nextFetch;
    const draft = this.draft;
    const version = draft.readVersion();
    const data = await this.api.get(this.id);
    if (request < this.appliedFetch || (current && !current())) return;
    this.appliedFetch = request;
    if (
      !this.state.data &&
      !preserveDraft &&
      this.draft === draft &&
      draft.readVersion() === version
    )
      this.draft = new DraftSync(this.env.clientId, data.draft);
    this.adopt(data, preserveDraft || this.draft !== draft, version);
  }
  connect(monitor = this.monitor): () => void {
    this.connected = true;
    let connecting = true;
    const conversation = this.state.data?.conversation;
    if (conversation?.kind === "chat" && conversation.closedAt !== null)
      queueMicrotask(() => {
        if (connecting) this.controller.notify("閉じた会話です。続きを書いて送ると再開します");
      });
    const main = this.view === "conversation";
    const oldPrompt = this.controller.options.prompt?.bind(this.controller.options);
    const removePrompt = main
      ? undefined
      : this.controller.registerWindowPrompt(this.view, () =>
          this.state.data ? this.prompt() : undefined,
        );
    if (main) this.controller.options.prompt = () => this.prompt();
    this.activeMonitor = monitor;
    const disconnectMonitor = main ? (monitor?.connect() ?? this.registerStop()) : undefined;
    if (!main) this.bindAction(conversationActions.stop, () => this.stopAgent());
    this.bindAction(conversationActions.resume, async () => {
      await this.api.resume(this.id);
      await this.refresh();
    });
    this.bindAction(conversationActions.sendQueue, async () => {
      this.requireUndoResult();
      await this.api.send(this.id, {
        text: "",
        images: [],
        mode: "send",
        clientMessageId: this.env.id(),
      });
      await this.refresh();
    });
    this.bindAction(conversationActions.deleteItem, () => this.deleteQueue());
    this.bindAction(conversationActions.editItem, () => this.editQueue());
    this.bindAction(conversationActions.undoItem, () => this.undoQueue());
    this.bindAction(conversationActions.expandDiff, () => this.fold(false));
    this.bindAction(conversationActions.collapseDiff, () => this.fold(true));
    this.bindAction(conversationActions.sendAnswers, () => this.sendAnswers(false));
    this.bindAction(conversationActions.confirmAnswers, () => this.sendAnswers(true));
    this.bindAction(conversationActions.answered, () => {
      this.controller.notify("この質問には、回答を送ってあります");
    });
    if (main) {
      this.removers.push(
        this.controller.commands.register({
          ...conversationCommands.images,
          run: async (args) => {
            if (args.join(" ") !== "clear") throw new Error("使い方: :images clear");
            this.editDraft(this.draft.content().text, []);
            await this.saveDraft();
          },
        }),
      );
      this.controller.setHints("conversation", [
        ["prompt.open", "入力"],
        ["conversation.switch", "会話を切り替える"],
      ]);
    }
    this.installQuestionActions();
    const disconnectRecap = this.recap?.connect();
    return () => {
      connecting = false;
      this.connected = false;
      this.questionRemovers.splice(0).forEach((remove) => remove());
      disconnectRecap?.();
      disconnectMonitor?.();
      if (this.activeMonitor === monitor) this.activeMonitor = undefined;
      this.cancelSave?.();
      if (
        this.ownsPrompt() ||
        (main &&
          this.controller.snapshot().prompt?.scope === undefined &&
          this.controller.snapshot().prompt?.label !== "質問" &&
          this.controller.snapshot().prompt?.verb !== "ストックする")
      )
        this.controller.closePrompt();
      if (this.draft.dirty()) void this.saveDraft();
      if (main) this.controller.options.prompt = oldPrompt;
      removePrompt?.();
      this.removers.splice(0).forEach((remove) => remove());
      this.handle = null;
    };
  }
  registerStop(): () => void {
    const unbind = this.controller.actions.register({
      ...timelineStopAction,
      run: () => this.stopAgent(),
    });
    const unregister = this.controller.commands.register({
      ...conversationCommands.stop,
      run: () => this.controller.run("agent.stop"),
    });
    return () => {
      unbind();
      unregister();
    };
  }
  private async stopAgent(): Promise<void> {
    await this.api.stop(this.id);
    this.controller.notify(
      `会話: ${this.state.data!.conversation.title} の AI を止めました。作業は保存され、指示待ちになります`,
    );
    await this.refresh();
  }
  private action(
    name: string,
    label: string,
    run: () => void | Promise<void>,
    confirm?: string,
  ): void {
    this.bindAction(conversationAction(name, label), run, confirm);
  }
  private bindAction(info: ActionInfo, run: () => void | Promise<void>, confirm?: string): void {
    this.removers.push(this.registerConversationAction(info, run, confirm));
  }
  private registerConversationAction(
    info: ActionInfo,
    run: () => void | Promise<void>,
    confirm?: string,
  ): () => void {
    return this.view === "conversation"
      ? this.controller.actions.register({ ...info, run, ...(confirm ? { confirm } : {}) })
      : this.controller.registerActionInterceptor(info.name, {
          views: [this.view],
          run: async (ctx) => {
            if (confirm) this.controller.confirm(confirm, ctx, run);
            else await run();
            return true;
          },
        });
  }
  eventRecords(): Event[] {
    return this.events;
  }
  private withUnread(lines: LineInfo[]): LineInfo[] {
    const index = lines.findIndex((line) => line.seq === this.unreadSeq && canPlaceCursor(line));
    return index < 0
      ? lines
      : [
          ...lines.slice(0, index),
          { kind: "separator", text: "ここから未読" },
          ...lines.slice(index),
        ];
  }
  searchLines(): LineInfo[] {
    return [
      ...this.blocks.flatMap((block) =>
        block.event.type === "diff"
          ? eventLines(block.event, this.id, this.state.data!.conversation.cwd, null, true)
          : block.lines,
      ),
      ...["reply", "question", "queue"].flatMap((part) => this.tailLines[part] ?? []),
    ];
  }
  bodyLines(): LineInfo[] {
    return [
      ...this.head,
      ...this.blocks.flatMap((block) => this.withUnread(block.lines)),
      ...["reply", "question", "queue"].flatMap((part) => this.tailLines[part] ?? []),
    ];
  }
  private setTail(part: "reply" | "question" | "queue", lines: LineInfo[]): void {
    this.tailLines[part] = part === "question" ? this.withUnread(lines) : lines;
    this.handle?.setTail(part, this.tailLines[part]);
  }
  hasQuestion = (): boolean => this.question !== null;
  surround(head: LineInfo[], footer: LineInfo[]): void {
    if (head !== this.head) this.handle?.replace(0, this.head.length, head);
    if (footer !== this.footer) this.handle?.setTail("issue-footer", footer);
    this.head = head;
    this.footer = footer;
  }
  bind = (handle: BufferHandle, openAtTail = false): void => {
    this.handle = handle;
    const body: LineInfo[] =
      this.blocks.length || this.question || this.state.data?.queue.length
        ? this.blocks.flatMap((block) => this.withUnread(block.lines))
        : [{ kind: "note", text: "i で指示を書いて送ると、AI が作業を始めます。" }];
    handle.replaceAll([...this.head, ...body]);
    if (this.footer.length > 0) handle.setTail("issue-footer", this.footer);
    this.refreshTail();
    if (this.recap) this.recap.bound(handle);
    else if (openAtTail && this.state.data?.conversation.runState === "working")
      handle.jumpTo(Math.max(0, this.bodyLines().length - 1), { remember: false });
  };
  private append(event: Event, lines: LineInfo[], clearReply = false): void {
    if (this.blocks.length === 0) this.handle?.replaceAll(this.head);
    this.blocks.push({ event, lines });
    this.handle?.append(this.withUnread(lines), clearReply ? ["reply"] : []);
  }
  private replaceBlock(block: Block, lines: LineInfo[]): void {
    const index = this.blocks.indexOf(block);
    const from = this.blocks
      .slice(0, index)
      .reduce((sum, block) => sum + this.withUnread(block.lines).length, this.head.length);
    this.handle?.replace(from, from + this.withUnread(block.lines).length, this.withUnread(lines));
    block.lines = lines;
  }
  receiveEvent(event: Event): void {
    if (event.seq <= this.contiguousSeq || this.pendingEvents.has(event.seq)) return;
    this.pendingEvents.set(event.seq, event);
    let next = this.pendingEvents.get(this.contiguousSeq + 1);
    while (next) {
      this.pendingEvents.delete(next.seq);
      this.contiguousSeq = next.seq;
      this.applyEvent(next);
      next = this.pendingEvents.get(this.contiguousSeq + 1);
    }
    this.recap?.received();
  }
  receivedThrough(): number {
    return this.contiguousSeq;
  }
  private applyEvent(event: Event): void {
    this.events.push(event);
    if (event.type === "question") {
      this.archiveQuestion();
      this.question = event;
      this.installQuestionActions();
      this.refreshTail();
      this.emit();
      return;
    }
    if (
      event.type === "answer" ||
      (event.type === "user_message" &&
        event.payload.origin !== "answer_text" &&
        event.payload.origin !== "resume")
    ) {
      if (event.type === "answer") {
        if (this.state.data) this.state.data.pendingAnswers = null;
      }
      this.archiveQuestion(event.type === "answer" ? event.payload.answers : {});
    }
    if (event.type === "assistant_text" || event.type === "turn_end") this.reply = "";
    const data = this.state.data;
    if (!data) return;
    if (event.type === "tool_result") {
      const use = this.blocks.find(
        (block) =>
          block.event.type === "tool_use" &&
          block.event.payload.tool_use_id === event.payload.tool_use_id,
      );
      if (use)
        this.replaceBlock(
          use,
          eventLines(use.event, this.id, data.conversation.cwd, event.payload.content),
        );
    }
    if (event.type === "diff" && this.view === "conversation")
      this.action(`conversation.diff.${event.seq}`, "差分を開く", () =>
        this.expandDiff(event.seq, true),
      );
    const openingQuestion =
      this.view === "stock-thread" &&
      event.type === "user_message" &&
      event.payload.origin === "stock" &&
      this.events.find((record) => record.type === "user_message") === event;
    this.append(
      event,
      openingQuestion
        ? []
        : event.type === "diff"
          ? this.diffLines(event, data.conversation.cwd, false)
          : eventLines(event, this.id, data.conversation.cwd),
      event.type === "assistant_text" || event.type === "turn_end",
    );
    this.refreshTail();
    this.emit();
  }
  private archiveQuestion(answers: Answers = {}): void {
    if (!this.question) return;
    const question = this.question;
    this.question = null;
    this.installQuestionActions();
    this.setTail("question", []);
    this.append(question, this.questionLines(question, answers, true));
  }
  delta(text: string): void {
    if (!this.blocks.length) this.handle?.replaceAll(this.head);
    this.reply += text;
    this.refreshTail();
    if (this.view === "stock-thread") this.emit();
  }
  private questionLines(question: QuestionEvent, answers: Answers, sent: boolean): LineInfo[] {
    const lines = question.payload.questions.flatMap((item, index): LineInfo[] => {
      const answer = answers[index];
      const choices = item.options.map((option, choice): LineInfo => {
        const selected = answer?.choices.includes(option.label) ?? false;
        const description = selected
          ? sent
            ? "✓ 送った回答"
            : "✓ 選んだ (まだ送っていない)"
          : "この選択肢を選ぶ";
        return {
          kind: "menu",
          text: `${option.label}  ${description}`,
          cols: [option.label, description],
          action: sent ? "conversation.answered" : `conversation.choice.${index}.${choice}`,
          done: selected,
          seq: question.seq,
        };
      });
      return [
        { kind: "ask", text: `Q${index + 1}. ${item.question}`, seq: question.seq },
        ...choices,
        ...(sent
          ? []
          : [
              {
                kind: "menu" as const,
                text: `Q${index + 1} に文章で答える`,
                action: `conversation.answer.${index}`,
                seq: question.seq,
              },
            ]),
        ...(answer?.text
          ? [
              {
                kind: "text" as const,
                text: `→ あなたの回答${sent ? "" : " (まだ送っていない)"}: ${answer.text}`,
                noQuote: true as const,
                seq: question.seq,
              },
            ]
          : []),
      ];
    });
    if (!sent) {
      const count = Object.values(answers).filter(
        (answer) => answer.choices.length || answer.text?.trim(),
      ).length;
      const total = question.payload.questions.length;
      const description =
        count === total ? "1 通にまとめて AI に届く" : `答えていない質問が ${total - count} 件ある`;
      lines.push({
        kind: "menu",
        text: `回答をまとめて送る (${count} / ${total} 件)  ${description}`,
        cols: [`回答をまとめて送る (${count} / ${total} 件)`, description],
        action: "conversation.answers.send",
        seq: question.seq,
        main: true,
      });
    }
    return lines.map((line, seqLine) => ({ ...line, seqLine }));
  }
  private installQuestionActions(): void {
    if (!this.connected) return;
    this.questionRemovers.splice(0).forEach((remove) => remove());
    const register = (name: string, label: string, run: () => void | Promise<void>) =>
      this.questionRemovers.push(
        this.registerConversationAction(conversationAction(name, label), run),
      );
    this.question?.payload.questions.forEach((item, index) => {
      item.options.forEach((option, choice) =>
        register(`conversation.choice.${index}.${choice}`, "選択肢を選ぶ", async () => {
          const current = this.state.data?.pendingAnswers?.answers ?? {};
          const answer = current[index] ?? { choices: [], text: null };
          const choices = answer.choices.includes(option.label)
            ? answer.choices.filter((label) => label !== option.label)
            : item.multi_select
              ? [...answer.choices, option.label]
              : [option.label];
          await this.saveAnswers({ ...current, [index]: { ...answer, choices } });
        }),
      );
      register(`conversation.answer.${index}`, "文章で答える", () => {
        this.controller.openPrompt({
          label: `Q${index + 1} への回答`,
          target: this.state.data!.conversation.title,
          verb: "決める",
          scope: this.id,
          initialText: this.state.data?.pendingAnswers?.answers[index]?.text ?? "",
          submit: async (text) => {
            const current = this.state.data?.pendingAnswers?.answers ?? {};
            await this.saveAnswers({
              ...current,
              [index]: { choices: current[index]?.choices ?? [], text },
            });
            this.controller.notify("回答を書きました。「回答をまとめて送る」で送ります");
          },
          close: () => {},
        });
      });
    });
  }
  private async saveAnswers(answers: Answers): Promise<void> {
    if (!this.question || !this.state.data) return;
    const result = await this.api.saveAnswers(this.id, this.question.seq, answers);
    this.state.data = { ...this.state.data, pendingAnswers: result.pendingAnswers };
    this.refreshTail();
    this.emit();
  }
  private async sendAnswers(confirmed: boolean): Promise<void> {
    if (!this.question) return;
    const answers = this.state.data?.pendingAnswers?.answers ?? {};
    const count = Object.values(answers).filter(
      (answer) => answer.choices.length || answer.text?.trim(),
    ).length;
    if (!count) {
      this.controller.notify("回答がまだありません。選択肢を選ぶか、文章で答えてください");
      return;
    }
    const missing = this.question.payload.questions.length - count;
    if (missing && !confirmed) {
      this.action(
        "conversation.answers.confirm",
        "回答を送る",
        () => this.sendAnswers(true),
        `答えていない質問が ${missing} 件あります。このまま送りますか?`,
      );
      await this.controller.run("conversation.answers.confirm");
      return;
    }
    try {
      await this.api.sendAnswers(this.id, confirmed);
    } catch (error) {
      if (
        error instanceof ConversationApiError &&
        error.code === "unanswered_questions" &&
        !confirmed
      ) {
        this.action(
          "conversation.answers.confirm",
          "回答を送る",
          () => this.sendAnswers(true),
          `答えていない質問が ${missing} 件あります。このまま送りますか?`,
        );
        await this.controller.run("conversation.answers.confirm");
        return;
      }
      throw error;
    }
    this.controller.notify(`回答 ${count} 件を 1 通にまとめて送りました`);
  }
  private refreshTail(): void {
    const data = this.state.data;
    if (!data) return;
    this.setTail(
      "reply",
      this.reply
        ? [
            { kind: "speaker", text: "AI" },
            ...this.reply.split("\n").map((text): LineInfo => ({ kind: "text", text })),
          ]
        : [],
    );
    const questionLines = this.question
      ? this.questionLines(
          this.question,
          data.pendingAnswers?.questionSeq === this.question.seq ? data.pendingAnswers.answers : {},
          false,
        )
      : [];
    const permission = data.pendingPermission;
    if (permission) {
      questionLines.push({
        kind: "ask",
        text: `許可の確認: ${permission.toolName}(${permission.summary})`,
        seq: permission.seq,
        seqLine: 0,
      });
      const choices = [
        ["allow", "許可する"],
        ["deny", "拒否する"],
      ] as const;
      for (const [index, [decision, label]] of choices.entries()) {
        this.action(`conversation.permission.${decision}`, label, async () => {
          await this.api.permission(this.id, permission.requestId, decision);
          await this.refresh();
        });
        questionLines.push({
          kind: "menu",
          text: label,
          action: `conversation.permission.${decision}`,
          seq: permission.seq,
          seqLine: index + 1,
        });
      }
    }
    this.setTail("question", questionLines);
    const queued = [...data.queue]
      .sort((a, b) => a.position - b.position)
      .map((item): LineInfo => ({
        kind: "queued",
        text: `届く前の指示: ${item.text.split("\n")[0]}`,
        id: `queue:${item.id}`,
      }));
    if (data.queue.length && !this.working())
      queued.push({ kind: "menu", text: "届く前の指示を送る", action: "conversation.queue.send" });
    const { runState, stopReason, resetsAt, closedAt } = data.conversation;
    if (
      ["failed", "usage_limited"].includes(runState) ||
      (runState === "stopped" && stopReason === "restarted")
    ) {
      if (!this.events.some((event) => event.type === "stopped"))
        queued.push({
          kind: "note",
          text: stoppedText(stopReason ?? "error", undefined, resetsAt, closedAt !== null),
          tone: "wait",
        });
      queued.push({
        kind: "menu",
        text: runState === "usage_limited" && closedAt === null ? "いま再開する" : "再開する",
        action: "conversation.resume",
      });
    }
    this.setTail("queue", queued);
  }
  private working(): boolean {
    return ["working", "waiting_answer", "waiting_permission"].includes(
      this.state.data?.conversation.runState ?? "idle",
    );
  }
  private prompt(): PromptSpec {
    const content = this.draft.content();
    return {
      label: this.queueEditing ? "預けた指示" : this.view === "stock-thread" ? "返信" : "指示",
      target: `${this.view === "stock-thread" ? "スレッド" : "会話"}: ${this.state.data!.conversation.title}`,
      scope: this.id,
      draftBinding: this.queueEditing
        ? { kind: "queue", itemId: this.queueEditing.id }
        : { kind: "message" },
      verb: "送る",
      initialText: content.text,
      images: content.images.length,
      commands: this.state.data!.commands,
      allowEmpty: true,
      allowChange: (text, edits) => this.allowUndoEdit({ ...this.draft.content(), text }, edits),
      change: (text, edits) => this.editDraft(text, undefined, edits),
      submit: (text) => this.send(text, false),
      interrupt: (text) => this.send(text, true),
      close: (text) => {
        if (text !== this.draft.content().text) this.editDraft(text);
        this.queueEditing = null;
        void this.saveDraft();
        if (text || this.draft.content().images.length)
          this.controller.notify(
            this.undo?.pending
              ? "書きかけは預け直しが確定したあとに保存します。"
              : "書きかけを残しました。i で続きを書けます",
          );
      },
      paste: (files) => {
        void this.paste(files).catch((error: unknown) =>
          this.controller.notify(this.reason(error), "error"),
        );
      },
    };
  }
  openConsultation(task: { id: string; title: string }): void {
    this.controller.closePrompt();
    const previous = this.draft.content();
    if (
      !this.updateDraft(
        joinDraftContent(
          previous,
          consultationContent(consultationPrefix(task.id, task.title), task.id),
        ),
      )
    )
      return;
    this.messageId = null;
    this.controller.openPrompt(this.prompt());
    void this.saveDraft();
  }
  async consultTimeline(
    task: { id: string; title: string },
    current: () => boolean,
  ): Promise<void> {
    if (!this.connected) await this.refresh(false, current);
    if (current()) this.openConsultation(task);
  }
  async continueTimeline(title: string): Promise<void> {
    this.requireUndoResult();
    await continueWork(
      title,
      (text) =>
        this.api.send(this.id, {
          text,
          images: [],
          mode: "send",
          clientMessageId: this.env.id(),
          preserveDraft: true,
          timeline_comments: [],
        }),
      (message) => this.controller.notify(message),
    );
    await this.refresh();
  }
  private editDraft(text: string, images = this.draft.content().images, edits?: ChangeDesc): void {
    const previous = this.draft.content();
    const anchors = previous.timeline_anchors;
    const change = edits ?? replaceRange(previous.text, text);
    if (
      !this.updateDraft(
        {
          text,
          images,
          ...(anchors === undefined
            ? {}
            : { timeline_anchors: mapTimelineAnchors(anchors, previous.text, text, change) }),
        },
        change,
      )
    )
      return;
    this.messageId = null;
    this.cancelSave?.();
    this.cancelSave = this.env.schedule(() => {
      void this.saveDraft();
    }, 500);
    this.syncDraftPrompt({ clearUnsent: !text && !images.length });
  }
  private movedCancelledDraft(content: DraftContent, edits: ChangeDesc): CancelledDraft | null {
    const undo = this.undo;
    if (!undo?.draft || undo.draft.version !== this.draft.version()) return null;
    return mapCancelledDraft(
      undo.draft,
      edits,
      content.images,
      undo.item,
      this.draft.version() + 1,
    );
  }
  private allowUndoEdit(content: DraftContent, edits: ChangeDesc): boolean {
    const undo = this.undo;
    if (!undo?.pending) return true;
    const moved = this.movedCancelledDraft(content, edits);
    if (moved && ownsCancelledDraft(content, moved, undo.item)) return true;
    this.controller.notify(undoPending, "error");
    return false;
  }
  private updateDraft(content: DraftContent, edits?: ChangeDesc): boolean {
    const previous = this.draft.content();
    const change = edits ?? replaceRange(previous.text, content.text);
    if (!this.allowUndoEdit(content, change)) return false;
    const moved = this.movedCancelledDraft(content, change);
    if (this.undo) this.undo.draft = moved;
    if (this.deferredDraftSave?.conflicted && !sameDraftContent(content, previous))
      this.deferredDraftSave = null;
    this.draft.edit(content, this.env.now());
    return true;
  }
  private requireUndoResult(): void {
    if (this.undo?.pending) throw new Error(undoPending);
  }
  private ownsPrompt(): boolean {
    return this.controller.snapshot().prompt?.scope === this.id;
  }

  private syncDraftPrompt({
    replaceText,
    clearUnsent,
  }: { replaceText?: boolean; clearUnsent?: boolean } = {}): void {
    const prompt = this.controller.snapshot().prompt;
    if (prompt?.scope !== this.id) return;
    const binding = prompt.draftBinding;
    const matches = this.queueEditing
      ? binding?.kind === "queue" && binding.itemId === this.queueEditing.id
      : binding?.kind === "message";
    if (!matches) return;
    const draft = this.draft.content();
    if (replaceText) this.controller.replacePromptText(draft.text);
    this.controller.patchPrompt({
      images: draft.images.length,
      ...(clearUnsent ? { unsent: undefined } : {}),
    });
  }

  proposeFinish(
    text: string,
    submit: (text: string, stillCurrent: () => boolean) => Promise<void>,
  ): void {
    if (this.controller.snapshot().prompt) return;
    if (!this.draft.content().text.trim() && text.trim()) this.editDraft(text);
    const draft = this.draft.content();
    this.controller.openPrompt({
      label: "確定事項",
      target: `スレッド: ${this.state.data!.conversation.title}`,
      verb: "ストックして終える",
      scope: this.id,
      initialText: draft.text,
      allowEmpty: true,
      change: (text) => this.editDraft(text),
      close: (text) => {
        if (text !== this.draft.content().text) this.editDraft(text);
        void this.saveDraft();
      },
      submit: async (text) => {
        if (!text.trim()) throw new Error("内容が空です。書いてからストックしてください");
        if (this.finishingDraft) return false;
        this.requireUndoResult();
        const draft = this.draft;
        const version = draft.version();
        const promptId = this.controller.snapshot().promptId;
        const opening = this.controller.screenOpening();
        const right = this.controller.right.openingRevision();
        const interaction = this.controller.interactionRevision();
        const stillCurrent = () => {
          const state = this.controller.snapshot();
          return (
            state.active === "prompt" &&
            state.prompt?.scope === this.id &&
            state.promptId === promptId &&
            this.controller.promptText() === text &&
            this.controller.screenOpening() === opening &&
            this.controller.right.openingRevision() === right &&
            this.controller.interactionRevision() === interaction &&
            !state.confirmation
          );
        };
        this.finishingDraft = true;
        this.cancelSave?.();
        this.cancelSave = null;
        try {
          await Promise.all(this.draftWrites);
          await submit(text, stillCurrent);
          if (this.draft === draft && draft.version() === version)
            this.draft = new DraftSync(this.env.clientId, null);
          return true;
        } finally {
          this.finishingDraft = false;
          if (this.draft.dirty()) void this.saveDraft();
        }
      },
    });
  }
  async saveDraft(): Promise<boolean> {
    this.cancelSave?.();
    this.cancelSave = null;
    if (!this.online || this.undo?.pending || this.finishingDraft) return false;
    if (!this.draft.dirty()) return true;
    const draft = this.draft;
    const deferred = this.deferredDraftSave?.local === draft ? this.deferredDraftSave : null;
    if (deferred?.conflicted) return false;
    if (deferred?.saving) {
      deferred.queued = true;
      return deferred.saving;
    }
    const saving = deferred
      ? this.persistDeferredDraft(draft, deferred)
      : this.persistDraft(draft, null);
    if (deferred) deferred.saving = saving;
    this.draftWrites.add(saving);
    try {
      return await saving;
    } finally {
      this.draftWrites.delete(saving);
    }
  }
  private async persistDeferredDraft(
    draft: DraftSync,
    deferred: DeferredDraftSave,
  ): Promise<boolean> {
    let retried = false;
    try {
      while (deferred === this.deferredDraftSave && draft === this.draft) {
        if (!this.online) return false;
        if (await this.persistDraft(draft, deferred)) {
          if (!draft.dirty()) return true;
          continue;
        }
        if (!deferred.queued || retried || !deferred.pending || deferred.conflicted) return false;
        retried = true;
        deferred.queued = false;
      }
      return true;
    } finally {
      delete deferred.saving;
      delete deferred.queued;
    }
  }
  private async persistDraft(
    draft: DraftSync,
    deferred: DeferredDraftSave | null,
  ): Promise<boolean> {
    const request = deferred
      ? (deferred.pending ??= { ...draft.request(), expectedDraft: deferred.expected })
      : draft.request();
    const version = draft.version();
    const undo = this.undo;
    try {
      const result = await this.api.saveDraft(this.id, request);
      const adopted = draft.saved(request, result.draft) && this.draft === draft;
      const stored = deferred !== null || result.applied || sameDraftContent(request, result.draft);
      if (deferred && deferred === this.deferredDraftSave) {
        delete deferred.pending;
        if (adopted || draft !== this.draft) this.deferredDraftSave = null;
        else deferred.expected = draftReceipt(request);
      }
      if (adopted && this.undo === undo && undo?.draft?.version === version && stored) {
        undo.draft.stored = result.draft;
        undo.draft.version = this.draft.version();
      }
      if (adopted && !stored) {
        this.syncDraftPrompt({ replaceText: true });
        this.controller.notify("別の端末で書いた内容に置き換わりました");
      }
      return true;
    } catch (error) {
      if (
        deferred &&
        deferred === this.deferredDraftSave &&
        error instanceof ConversationApiError &&
        error.status < 500
      ) {
        delete deferred.pending;
        if (error.status === 409) deferred.conflicted = true;
      }
      this.controller.notify(this.reason(error), "error");
      return false;
    }
  }
  private async send(text: string, interrupt: boolean): Promise<boolean> {
    this.requireUndoResult();
    const draft = this.draft;
    const version = draft.version();
    const images = [...draft.content().images];
    const editing = this.queueEditing;
    const anchors = draft.content().timeline_anchors;
    const structured = anchors === undefined ? {} : { timeline_anchors: anchors };
    const promptId = this.controller.snapshot().promptId;
    const submissionIsOpen = () => {
      const state = this.controller.snapshot();
      return (
        state.promptId === promptId &&
        state.prompt?.scope === this.id &&
        state.prompt.draftBinding !== undefined
      );
    };
    let sentMessageId: string | null = null;
    if (!text.trim() && !images.length && !this.state.data?.queue.length)
      throw new Error("内容が空です。書いてから送ってください");
    this.cancelSave?.();
    try {
      if (!this.online) throw new Error("サーバーにつながりません");
      if (hasUnlocatedEdits({ text, ...structured })) throw new Error(unlocatedConsultationNotice);
      if (editing) {
        await this.api.editQueue(this.id, editing.id, { text, images, ...structured });
      } else {
        this.messageId ??= this.env.id();
        sentMessageId = this.messageId;
        const queueCount = this.state.data?.queue.length ?? 0;
        const conversation = this.state.data?.conversation;
        const reopening = conversation?.kind === "chat" && conversation.closedAt !== null;
        const result = await this.api.send(this.id, {
          text,
          images,
          mode: interrupt ? "interrupt" : "send",
          clientMessageId: sentMessageId,
          ...(anchors === undefined
            ? {}
            : { ...structured, timeline_comments: commentsFromAnchors(text, anchors) }),
        });
        this.controller.notify(
          reopening
            ? "送りました。会話を再開し、一覧に戻します"
            : result.result === "queued"
              ? "預けました。今の作業が終わると届きます"
              : interrupt && this.working()
                ? queueCount
                  ? `AI を止めて、届く前の指示 ${queueCount} 件と一緒にすぐに送りました`
                  : "AI を止めて、すぐに送りました"
                : images.length
                  ? `画像 ${images.length} 件と一緒に送りました`
                  : "送りました",
        );
      }
      const unchanged = this.draft === draft && draft.version() === version;
      if (editing && unchanged && this.queueEditing === editing) this.queueEditing = null;
      if (unchanged) this.draft = new DraftSync(this.env.clientId, null);
      else await this.saveDraft();
      if (this.messageId === sentMessageId) this.messageId = null;
      if (submissionIsOpen()) this.controller.patchPrompt({ unsent: undefined });
      void this.refresh().catch((error: unknown) =>
        this.controller.notify(this.reason(error), "error"),
      );
      return unchanged;
    } catch (error) {
      if (editing && error instanceof ConversationApiError && error.status === 404) {
        if (this.queueEditing === editing) this.queueEditing = null;
        await this.refresh(true);
        if (submissionIsOpen()) {
          this.controller.openPrompt(this.prompt());
          this.controller.patchPrompt({ unsent: "すでに届きました" });
        }
        throw new Error("すでに届きました");
      }
      if (submissionIsOpen()) this.controller.patchPrompt({ unsent: this.reason(error) });
      throw error;
    }
  }
  private async paste(files: File[]): Promise<void> {
    for (const file of files) {
      if (
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("画像は PNG・JPEG・GIF・WebP、1 枚 5 MB までです");
      if (this.draft.content().images.length >= 20) throw new Error("画像は 1 通に 20 枚までです");
      const { image } = await this.api.upload(this.id, file);
      this.editDraft(this.draft.content().text, [...this.draft.content().images, image.id]);
    }
  }
  private selectedQueue(): QueueItem | undefined {
    const line = this.controller.currentLine();
    return this.state.data?.queue.find((item) => `queue:${item.id}` === line?.id);
  }
  private async deleteQueue(): Promise<void> {
    const item = this.selectedQueue();
    if (!item || this.queueOperation) return;
    this.requireUndoResult();
    this.queueOperation = true;
    try {
      if (!item.stockItemId && !(await this.saveDraft()))
        throw new Error("書きかけを保存できませんでした");
      const previous = this.draft.content();
      await this.api.deleteQueue(this.id, item.id);
      const undo: QueueUndo = { item, draft: null };
      this.undo = undo;
      if (this.state.data)
        this.state.data = {
          ...this.state.data,
          queue: this.state.data.queue.filter((queued) => queued.id !== item.id),
        };
      this.refreshTail();
      this.emit();
      if (!item.stockItemId) {
        const stored = (await this.api.get(this.id)).draft;
        const current = this.draft.content();
        const { content, addition } = appendCancelledDraft(previous, item);
        if (sameDraftContent(content, stored)) {
          if (sameDraftContent(previous, current))
            this.draft.edit(content, Math.max(this.env.now(), stored?.updatedAt ?? 0));
          if (sameDraftContent(content, this.draft.content()))
            undo.draft = { ...addition, version: this.draft.version(), stored };
        } else if (sameDraftContent(previous, current)) {
          this.draft = new DraftSync(this.env.clientId, stored);
        }
      }
      this.controller.notify("預けた指示を取り消しました。u で戻せます");
    } catch (error) {
      if (error instanceof ConversationApiError && error.status === 404) {
        await this.refresh();
        this.controller.notify("すでに届きました");
      } else throw error;
    } finally {
      this.queueOperation = false;
    }
  }
  private async undoQueue(): Promise<void> {
    const undo = this.undo;
    if (!undo || this.queueOperation) return;
    this.queueOperation = true;
    try {
      const { item } = undo;
      if (item.stockItemId)
        await this.api.sendStock(this.id, { kinds: "instructions", stockIds: [item.stockItemId] });
      else {
        undo.pending ??= await this.prepareUndoRequest(undo);
        await this.api.send(this.id, undo.pending.message);
        this.reconcileRestoredDraft(undo);
      }
      this.undo = null;
      const failedSave = this.deferredDraftSave?.local === this.draft && !(await this.saveDraft());
      await this.refresh(failedSave);
    } catch (error) {
      if (error instanceof ConversationApiError && error.status === 409 && undo.pending) {
        this.deferredDraftSave = { local: this.draft, conflicted: true };
        this.undo = null;
      }
      throw error;
    } finally {
      this.queueOperation = false;
    }
  }
  private reconcileRestoredDraft(undo: QueueUndo): void {
    const pending = undo.pending!;
    const added = undo.draft;
    if (this.draft !== pending.local || !added || added.version !== this.draft.version()) return;
    const remaining = removeCancelledDraft(this.draft.content(), added, undo.item);
    if (!remaining) return;
    const replacement = pending.message.restoreDraft!.replacement;
    this.draft = new DraftSync(this.env.clientId, replacement);
    if (!sameDraftContent(remaining, replacement)) {
      this.draft.edit(remaining, this.env.now());
      this.deferredDraftSave = { local: this.draft, expected: replacement, conflicted: false };
    }
    if (this.connected && this.view === "conversation" && !this.queueEditing)
      this.syncDraftPrompt({ replaceText: true });
  }
  private async prepareUndoRequest(undo: QueueUndo): Promise<UndoRequest> {
    const { draft: added, item } = undo;
    const local = this.draft;
    const version = local.version();
    if (!added || added.version !== version) throw new Error(undoConflict);
    const latest = (await this.api.get(this.id)).draft;
    if (
      this.draft !== local ||
      local.version() !== version ||
      !(
        sameDraftReceipt(added.stored, latest) ||
        (latest?.updatedBy === this.env.clientId && sameDraftContent(local.content(), latest))
      )
    )
      throw new Error(undoConflict);
    const remaining = removeCancelledDraft(local.content(), added, item);
    if (!remaining) throw new Error(undoConflict);
    this.cancelSave?.();
    this.cancelSave = null;
    return {
      local,
      message: {
        text: item.text,
        images: item.images,
        mode: "send",
        clientMessageId: this.env.id(),
        ...(item.timeline_comments === undefined
          ? {}
          : { timeline_comments: item.timeline_comments }),
        ...(item.timeline_anchors === undefined ? {} : { timeline_anchors: item.timeline_anchors }),
        preserveDraft: true,
        restoreDraft: {
          expected: latest,
          replacement: {
            ...remaining,
            updatedBy: this.env.clientId,
            updatedAt: Math.max(
              this.env.now(),
              local.request().editedAt + 1,
              (latest?.updatedAt ?? 0) + 1,
            ),
          },
        },
      },
    };
  }
  private editQueue(): void {
    this.requireUndoResult();
    const item = this.selectedQueue();
    if (!item) return;
    this.controller.closePrompt();
    this.queueEditing = item;
    this.draft.edit(queueDraftContent(item), this.env.now());
    this.controller.openPrompt(this.prompt());
  }
  private fold(collapse: boolean): void {
    const seq = this.controller.currentLine()?.seq;
    if (seq !== undefined) this.expandDiff(seq, !collapse);
  }
  private diffLines(
    event: Extract<Event, { type: "diff" }>,
    cwd: string,
    open: boolean,
  ): LineInfo[] {
    return eventLines(event, this.id, cwd, null, open).map((line) =>
      line.kind === "menu" ? { ...line, open: () => this.expandDiff(event.seq, true) } : line,
    );
  }
  expandDiff(seq: number, open: boolean): void {
    const block = this.blocks.find((block) => block.event.seq === seq);
    if (block?.event.type !== "diff" || !this.state.data) return;
    this.replaceBlock(block, this.diffLines(block.event, this.state.data.conversation.cwd, open));
    if (this.view === "stock-thread") this.emit();
  }
  receive(message: ServerMessage): void {
    if (message.topic !== `conversation:${this.id}`) return;
    (this.activeMonitor ?? this.monitor)?.receive(message);
    if (
      message.type === "changed" &&
      message.payload.parts?.length === 1 &&
      message.payload.parts[0] === "timeline"
    )
      return;
    if (message.type === "changed" || message.type === "state") this.recap?.changed();
    if (message.type === "delta") this.delta(message.payload.text);
    else if (message.type === "event") {
      const value = eventSchema.safeParse(message.payload);
      if (value.success)
        this.receiveEvent({
          ...value.data,
          seq: message.seq,
          createdAt: message.payload.created_at,
        });
    } else if (message.type === "state" || message.type === "changed")
      void this.refresh().catch((error: unknown) =>
        this.controller.notify(this.reason(error), "error"),
      );
  }
  connection(online: boolean): void {
    this.online = online;
    if (online) void this.saveDraft();
  }
  private reason(error: unknown): string {
    return error instanceof Error ? error.message : "操作に失敗しました";
  }
}
