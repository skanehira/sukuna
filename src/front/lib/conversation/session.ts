import type { ActionInfo } from "../../buffer/keymap/registry";
import { conversationAction, conversationActions, conversationCommands } from "./keymap";
import type { Answers } from "../../../shared/events";
import { eventSchema } from "../../../shared/events";
import type { ServerMessage } from "../../../shared/ws";
import type { BufferHandle } from "../../buffer/Buffer";
import type { BufferController, PromptSpec } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import { canPlaceCursor } from "../../buffer/no-cursor";
import type { RecapSession } from "../recap/session";
import { DraftSync } from "./draft-sync";
import { ConversationApiError } from "./api";
import { eventLines, stoppedText } from "./lines";
import type { ConversationApi, DraftContent, Event, QueueItem, Snapshot } from "./types";

export type ConversationEnvironment = {
  clientId: string;
  id(): string;
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
};
type QuestionEvent = Extract<Event, { type: "question" }>;
type Block = { event: Event; lines: LineInfo[] };
export class ConversationSession {
  recap?: RecapSession;
  unreadSeq: number | null = null;
  private tailLines: Record<string, LineInfo[]> = {};
  private state: { data: Snapshot | null; version: number } = { data: null, version: 0 };
  private listeners = new Set<() => void>();
  private handle: BufferHandle | null = null;
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
  private cancelSave: (() => void) | null = null;
  private messageId: string | null = null;
  private undo: QueueItem | null = null;
  private undoDraft: DraftContent | null = null;
  private queueEditing: QueueItem | null = null;
  private online = true;
  readonly id: string;
  readonly api: ConversationApi;
  readonly controller: BufferController;
  private env: ConversationEnvironment;
  constructor(
    id: string,
    api: ConversationApi,
    controller: BufferController,
    env: ConversationEnvironment,
  ) {
    this.id = id;
    this.api = api;
    this.controller = controller;
    this.env = env;
    this.draft = new DraftSync(env.clientId, null);
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
    this.emit();
    return this.id;
  }
  private adopt(data: Snapshot, preserveDraft = false, readVersion?: number): void {
    this.state = { ...this.state, data };
    const result = preserveDraft
      ? { replaced: false, notice: null }
      : this.draft.receive(data.draft, readVersion);
    if (result.notice) this.controller.notify(result.notice);
    if (result.replaced && this.controller.snapshot().prompt?.label === "指示")
      this.controller.replacePromptText(this.draft.content().text);
    this.refreshPrompt();
    this.refreshTail();
    this.emit();
  }
  async refresh(preserveDraft = false): Promise<void> {
    const request = ++this.nextFetch;
    const draft = this.draft;
    const version = draft.readVersion();
    const data = await this.api.get(this.id);
    if (request < this.appliedFetch) return;
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
  connect(): () => void {
    let connecting = true;
    const conversation = this.state.data?.conversation;
    if (conversation?.kind === "chat" && conversation.closedAt !== null)
      queueMicrotask(() => {
        if (connecting) this.controller.notify("閉じた会話です。続きを書いて送ると再開します");
      });
    const oldPrompt = this.controller.options.prompt?.bind(this.controller.options);
    this.controller.options.prompt = () => this.prompt();
    this.bindAction(conversationActions.stop, async () => {
      await this.api.stop(this.id);
      this.controller.notify(
        `会話: ${this.state.data!.conversation.title} の AI を止めました。作業は保存され、指示待ちになります`,
      );
      await this.refresh();
    });
    this.bindAction(conversationActions.resume, async () => {
      await this.api.resume(this.id);
      await this.refresh();
    });
    this.bindAction(conversationActions.sendQueue, async () => {
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
    this.bindAction(conversationActions.undoItem, async () => {
      const item = this.undo;
      if (!item) return;
      if (item.stockItemId)
        await this.api.sendStock(this.id, { kinds: "instructions", stockIds: [item.stockItemId] });
      else {
        if (this.undoDraft) {
          const current = this.draft.content();
          const restored = [this.undoDraft.text, item.text].filter(Boolean).join("\n\n");
          const from = this.undoDraft.images.length;
          const imageBlock = current.images.slice(from, from + item.images.length);
          const hasImages =
            imageBlock.length === item.images.length &&
            imageBlock.every((id, index) => id === item.images[index]);
          this.draft.edit(
            {
              text: current.text.startsWith(restored)
                ? this.undoDraft.text + current.text.slice(restored.length)
                : current.text,
              images: hasImages
                ? [
                    ...current.images.slice(0, from),
                    ...current.images.slice(from + item.images.length),
                  ]
                : current.images,
            },
            this.env.now(),
          );
          if (!(await this.saveDraft())) throw new Error("書きかけを保存できませんでした");
        }
        await this.api.send(this.id, {
          text: item.text,
          images: item.images,
          mode: "send",
          clientMessageId: this.env.id(),
        });
      }
      this.undo = null;
      this.undoDraft = null;
      await this.refresh();
    });
    this.bindAction(conversationActions.expandDiff, () => this.fold(false));
    this.bindAction(conversationActions.collapseDiff, () => this.fold(true));
    this.bindAction(conversationActions.sendAnswers, () => this.sendAnswers(false));
    this.bindAction(conversationActions.confirmAnswers, () => this.sendAnswers(true));
    this.bindAction(conversationActions.answered, () => {
      this.controller.notify("この質問には、回答を送ってあります");
    });
    this.removers.push(
      this.controller.commands.register({
        ...conversationCommands.stop,
        run: () => this.controller.run("agent.stop"),
      }),
    );
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
    this.installQuestionActions();
    this.controller.setHints("conversation", [
      ["prompt.open", "入力"],
      ["conversation.switch", "会話を切り替える"],
    ]);
    const disconnectRecap = this.recap?.connect();
    return () => {
      connecting = false;
      disconnectRecap?.();
      this.cancelSave?.();
      this.controller.closePrompt();
      if (this.draft.dirty()) void this.saveDraft();
      this.controller.options.prompt = oldPrompt;
      this.removers.splice(0).forEach((remove) => remove());
      this.handle = null;
    };
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
    this.removers.push(
      this.controller.actions.register({ ...info, run, ...(confirm ? { confirm } : {}) }),
    );
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
      ...this.blocks.flatMap((block) => this.withUnread(block.lines)),
      ...["reply", "question", "queue"].flatMap((part) => this.tailLines[part] ?? []),
    ];
  }
  private setTail(part: "reply" | "question" | "queue", lines: LineInfo[]): void {
    this.tailLines[part] = part === "question" ? this.withUnread(lines) : lines;
    this.handle?.setTail(part, this.tailLines[part]);
  }
  bind = (handle: BufferHandle, openAtTail = false): void => {
    this.handle = handle;
    handle.replaceAll(
      this.blocks.length || this.question || this.state.data?.queue.length
        ? this.blocks.flatMap((block) => this.withUnread(block.lines))
        : [{ kind: "note", text: "i で指示を書いて送ると、AI が作業を始めます。" }],
    );
    this.refreshTail();
    if (this.recap) this.recap.bound(handle);
    else if (openAtTail)
      handle.jumpTo(Math.max(0, this.bodyLines().length - 1), { remember: false });
  };
  private append(event: Event, lines: LineInfo[], clearReply = false): void {
    if (this.blocks.length === 0) this.handle?.replaceAll([]);
    this.blocks.push({ event, lines });
    this.handle?.append(this.withUnread(lines), clearReply ? ["reply"] : []);
  }
  private replaceBlock(block: Block, lines: LineInfo[]): void {
    const index = this.blocks.indexOf(block);
    const from = this.blocks
      .slice(0, index)
      .reduce((sum, block) => sum + this.withUnread(block.lines).length, 0);
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
    if (event.type === "diff")
      this.action(`conversation.diff.${event.seq}`, "差分を開く", () =>
        this.expandDiff(event.seq, true),
      );
    this.append(
      event,
      eventLines(event, this.id, data.conversation.cwd),
      event.type === "assistant_text" || event.type === "turn_end",
    );
    this.refreshTail();
    this.emit();
  }
  private archiveQuestion(answers: Answers = {}): void {
    if (!this.question) return;
    const question = this.question;
    this.question = null;
    this.setTail("question", []);
    this.append(question, this.questionLines(question, answers, true));
  }
  delta(text: string): void {
    if (!this.blocks.length) this.handle?.replaceAll([]);
    this.reply += text;
    this.refreshTail();
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
    this.question?.payload.questions.forEach((item, index) => {
      item.options.forEach((option, choice) =>
        this.action(`conversation.choice.${index}.${choice}`, "選択肢を選ぶ", async () => {
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
      this.action(`conversation.answer.${index}`, "文章で答える", () => {
        this.controller.openPrompt({
          label: `Q${index + 1} への回答`,
          target: this.state.data!.conversation.title,
          verb: "決める",
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
      label: this.queueEditing ? "預けた指示" : "指示",
      target: `会話: ${this.state.data!.conversation.title}`,
      verb: "送る",
      initialText: content.text,
      images: content.images.length,
      commands: this.state.data!.commands,
      allowEmpty: true,
      change: (text) => this.editDraft(text),
      submit: (text) => this.send(text, false),
      interrupt: (text) => this.send(text, true),
      close: (text) => {
        if (text !== this.draft.content().text) this.editDraft(text);
        this.queueEditing = null;
        void this.saveDraft();
        if (text || this.draft.content().images.length)
          this.controller.notify("書きかけを残しました。i で続きを書けます");
      },
      paste: (files) => {
        void this.paste(files).catch((error: unknown) =>
          this.controller.notify(this.reason(error), "error"),
        );
      },
    };
  }
  private editDraft(text: string, images = this.draft.content().images): void {
    this.messageId = null;
    this.draft.edit({ text, images }, this.env.now());
    this.cancelSave?.();
    this.cancelSave = this.env.schedule(() => {
      void this.saveDraft();
    }, 500);
    this.refreshPrompt();
    if (!text && !images.length) this.controller.patchPrompt({ unsent: undefined });
  }
  private refreshPrompt(): void {
    if (["指示", "預けた指示"].includes(this.controller.snapshot().prompt?.label ?? ""))
      this.controller.patchPrompt({ images: this.draft.content().images.length });
  }
  async saveDraft(): Promise<boolean> {
    this.cancelSave?.();
    this.cancelSave = null;
    if (!this.online) return false;
    if (!this.draft.dirty()) return true;
    const draft = this.draft;
    const request = draft.request();
    try {
      const result = await this.api.saveDraft(this.id, request);
      if (draft.saved(request, result.draft) && this.draft === draft && !result.applied) {
        this.controller.replacePromptText(this.draft.content().text);
        this.controller.notify("別の端末で書いた内容に置き換わりました");
      }
      return true;
    } catch (error) {
      this.controller.notify(this.reason(error), "error");
      return false;
    }
  }
  private async send(text: string, interrupt: boolean): Promise<boolean> {
    const draft = this.draft;
    const version = draft.version();
    const images = [...draft.content().images];
    const editing = this.queueEditing;
    const promptId = this.controller.snapshot().promptId;
    let sentMessageId: string | null = null;
    if (!text.trim() && !images.length && !this.state.data?.queue.length)
      throw new Error("内容が空です。書いてから送ってください");
    this.cancelSave?.();
    try {
      if (!this.online) throw new Error("サーバーにつながりません");
      if (editing) {
        await this.api.editQueue(this.id, editing.id, { text, images });
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
      if (this.controller.snapshot().promptId === promptId)
        this.controller.patchPrompt({ unsent: undefined });
      void this.refresh().catch((error: unknown) =>
        this.controller.notify(this.reason(error), "error"),
      );
      return unchanged;
    } catch (error) {
      if (editing && error instanceof ConversationApiError && error.status === 404) {
        if (this.queueEditing === editing) this.queueEditing = null;
        await this.refresh(true);
        if (this.controller.snapshot().prompt && this.controller.snapshot().promptId === promptId) {
          this.controller.openPrompt(this.prompt());
          this.controller.patchPrompt({ unsent: "すでに届きました" });
        }
        throw new Error("すでに届きました");
      }
      if (this.controller.snapshot().promptId === promptId)
        this.controller.patchPrompt({ unsent: this.reason(error) });
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
    if (!item) return;
    try {
      await this.api.deleteQueue(this.id, item.id);
      this.undo = item;
      this.undoDraft = item.stockItemId ? null : this.draft.content();
      if (this.undoDraft)
        this.draft.edit(
          {
            text: [this.undoDraft.text, item.text].filter(Boolean).join("\n\n"),
            images: [...this.undoDraft.images, ...item.images],
          },
          this.env.now(),
        );
      if (this.state.data)
        this.state.data = {
          ...this.state.data,
          queue: this.state.data.queue.filter((queued) => queued.id !== item.id),
        };
      this.refreshTail();
      this.emit();
      this.controller.notify("預けた指示を取り消しました。u で戻せます");
    } catch (error) {
      if (error instanceof ConversationApiError && error.status === 404) {
        await this.refresh();
        this.controller.notify("すでに届きました");
      } else throw error;
    }
  }
  private editQueue(): void {
    const item = this.selectedQueue();
    if (!item) return;
    this.controller.closePrompt();
    this.queueEditing = item;
    this.draft.edit({ text: item.text, images: item.images }, this.env.now());
    this.controller.openPrompt(this.prompt());
  }
  private fold(collapse: boolean): void {
    let offset = 0;
    for (const block of this.blocks) {
      if (
        this.controller.context().line >= offset &&
        this.controller.context().line < offset + this.withUnread(block.lines).length &&
        block.event.type === "diff"
      ) {
        this.expandDiff(block.event.seq, !collapse);
        return;
      }
      offset += this.withUnread(block.lines).length;
    }
  }
  expandDiff(seq: number, open: boolean): void {
    const block = this.blocks.find((block) => block.event.seq === seq);
    if (!block || !this.state.data) return;
    this.replaceBlock(
      block,
      eventLines(block.event, this.id, this.state.data.conversation.cwd, null, open),
    );
  }
  receive(message: ServerMessage): void {
    if (message.topic !== `conversation:${this.id}`) return;
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
