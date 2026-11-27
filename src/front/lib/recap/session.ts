import type { DecisionsResponse, RecapResponse, TocResponse } from "../../../shared/recap/api";
import type { BufferHandle } from "../../buffer/Buffer";
import { CommandRetry } from "../../buffer/commands";
import type { ActionInfo } from "../../buffer/keymap/registry";
import { canPlaceCursor } from "../../buffer/no-cursor";
import type { LineInfo } from "../../buffer/line";
import type { ConversationSession } from "../conversation/session";
import type { Event, Snapshot } from "../conversation/types";
import { ConversationApiError } from "../conversation/api";
import { eventLines } from "../conversation/lines";
import type { RecapApi } from "./api";
import { recapAction, recapActions, recapCommands, recapItemActions } from "./keymap";
import { openPosition } from "./open-position";
import {
  forgetOpening,
  ReadTracking,
  rememberOpening,
  type Opening,
  type TabStorage,
} from "./read-tracking";
import { searchRecap } from "./search";
export type RecapView = "recent" | "toc" | "decisions" | "recap-search";
type Decision = DecisionsResponse["items"][number];
type Chapter = TocResponse["chapters"][number];
type DeletedDecision = {
  item: Decision;
  before: string[];
  after: string[];
  links: Decision[];
};
const conflict = (error: unknown): error is ConversationApiError =>
  error instanceof ConversationApiError && error.status === 409;
const labels = { decision: "決定", rejected: "採らなかった案", pending: "保留" };
export class RecapSession {
  private opening: Opening | null = null;
  private position: ReturnType<typeof openPosition> | null = null;
  private recent: RecapResponse | null = null;
  private toc: TocResponse | null = null;
  private decisions: DecisionsResponse | null = null;
  private failures: Partial<Record<RecapView, string>> = {};
  private requests: Partial<Record<RecapView, number>> = {};
  private openingRequest = 0;
  private rememberedPrevious = false;
  private mountReady: RecapView | null = null;
  private query = "";
  private right: { view: RecapView; handle: BufferHandle } | null = null;
  private main: BufferHandle | null = null;
  private tracking: ReadTracking;
  private undo: DeletedDecision | null = null;
  private openingCursorRevision = 0;
  private selectedWhileLoading: { line: LineInfo; index: number; column: number } | null = null;
  private cancelCursor: (() => void) | null = null;
  readonly conversation: ConversationSession;
  private api: RecapApi;
  private storage: TabStorage;
  constructor(
    conversation: ConversationSession,
    api: RecapApi,
    storage: TabStorage,
    schedule: (fn: () => void, ms: number) => () => void,
  ) {
    this.conversation = conversation;
    this.api = api;
    this.storage = storage;
    this.tracking = new ReadTracking(
      (body, keepalive) => api.read(conversation.id, body, keepalive),
      schedule,
    );
  }
  loaded(data: Snapshot, events: Event[]): void {
    if (this.opening) return;
    this.opening = rememberOpening(
      this.storage,
      this.conversation.id,
      data.conversation.lastReadSeq,
      data.conversation.lastPosition,
    );
    if (this.main && (this.main.cursorRevision?.() ?? 0) !== this.openingCursorRevision) {
      const cursor = this.conversation.controller.windowPosition("main");
      const line = this.conversation.controller.currentLine("main");
      if (cursor && line)
        this.selectedWhileLoading = { line, index: cursor.line, column: cursor.column };
    }
    const visibleEvents = events.filter(
      (event) =>
        event.type === "question" ||
        (event.type === "permission_request" && event.seq === data.pendingPermission?.seq) ||
        eventLines(event, this.conversation.id, data.conversation.cwd).some(canPlaceCursor),
    );
    this.position = openPosition(
      visibleEvents,
      this.opening.lastReadSeq,
      data.conversation.runState === "working",
    );
    this.conversation.unreadSeq = this.position.unreadSeq;
    if (this.main) this.conversation.bind(this.main);
  }
  bound(handle: BufferHandle): void {
    if (this.main !== handle) {
      this.main = handle;
      this.openingCursorRevision = handle.cursorRevision?.() ?? 0;
    }
    if (!this.position || !this.opening) return;
    const lines = this.conversation.bodyLines();
    const previous = this.findLine(this.opening.lastPosition, lines);
    const restoring = this.conversation.controller.options.restoringPosition;
    if (!restoring && previous !== null && !this.rememberedPrevious) {
      handle.pushJump(previous);
      this.rememberedPrevious = true;
    }
    const moved = this.selectedWhileLoading;
    this.selectedWhileLoading = null;
    const line = this.position.tail ? lines.length - 1 : this.findLine(this.position.seq, lines);
    if (moved) {
      const index = lines.findIndex((line) =>
        moved.line.id
          ? line.id === moved.line.id
          : line.seq === moved.line.seq &&
            line.seqLine === moved.line.seqLine &&
            line.kind === moved.line.kind &&
            line.text === moved.line.text,
      );
      handle.jumpTo(index >= 0 ? index : moved.index, { remember: false, column: moved.column });
    } else if (line !== null && line >= 0) {
      const topLine = lines[line - 1]?.kind === "separator" ? line - 1 : line;
      handle.jumpTo(line, { remember: false, ...(this.position.tail ? {} : { topLine }) });
    }
    this.tracking.open(this.conversation.receivedThrough());
    this.tracking.cursor(this.cursorSeq());
    const right = this.conversation.controller.right.current?.view;
    if (this.position.recent && right !== "thread" && right !== "conversation-switch")
      void this.open("recent", false);
  }
  private findLine(seq: number | null, lines = this.conversation.bodyLines()): number | null {
    if (seq === null) return null;
    const found = lines.findIndex((line) => line.seq === seq && canPlaceCursor(line));
    return found >= 0 ? found : null;
  }
  private cursorSeq(): number | null {
    return this.conversation.controller.currentLine("main")?.seq ?? null;
  }
  connect(): () => void {
    const controller = this.conversation.controller;
    const removers: (() => void)[] = [];
    const register = (action: ActionInfo, run: () => void | Promise<void>) => {
      removers.push(controller.actions.register({ ...action, run }));
    };
    for (const view of ["recent", "toc", "decisions"] as const)
      register(recapActions[view], () => this.open(view));
    register(recapActions.search, () =>
      controller.openSearch(async (query) => {
        const current = this.beginRightOpening();
        const [toc, decisions] = await Promise.all([
          this.api.toc(this.conversation.id),
          this.api.decisions(this.conversation.id),
        ]);
        if (!current()) return;
        this.query = query;
        this.toc = toc;
        this.decisions = decisions;
        controller.openRight({ view: "recap-search", target: this.conversation.id });
      }),
    );
    for (const [action, run] of [
      [recapItemActions.edit, () => this.edit()],
      [recapItemActions.delete, () => this.remove()],
      [recapItemActions.undo, () => this.restore()],
    ] as const) {
      const old = controller.actions.get(action.name);
      register({ ...action, views: ["conversation", ...action.views] }, () =>
        controller.context().view === "conversation" ? old?.run(controller.context()) : run(),
      );
      if (old)
        removers.push(() => {
          controller.actions.register(old);
        });
    }
    removers.push(
      controller.commands.register({
        ...recapCommands.toc,
        run: async (args) => {
          if (args[0] !== "start" || args.length !== 2 || !/^\d+$/.test(args[1]))
            throw new Error("使い方: :toc start <章の番号>");
          const position = Number(args[1]);
          const seq = this.cursorSeq();
          if (!Number.isSafeInteger(position) || position < 1 || seq === null)
            throw new Error("章か本文の行を選んでください");
          await this.moveChapter(position, seq);
        },
      }),
    );
    const jump = (name: string, label: string, run: () => void | Promise<void>) => {
      register(recapAction(name, label, ["recent", "toc", "decisions", "recap-search"]), run);
    };
    jump("recap.jump", "本文へ移る", () => this.selectedJump());
    jump("recap.open-toc", "目次", () => this.open("toc"));
    jump("recap.open-decisions", "決まったこと", () => this.open("decisions"));
    jump("recap.rebuild", "目次を作り直す", async () => {
      const current = this.beginRightOpening();
      await this.api.rebuild(this.conversation.id);
      if (current()) await this.open("toc", true, current);
    });
    jump("recap.draft", "入力の続きを書く", () =>
      controller.run("prompt.open", {
        window: "main",
        view: "conversation",
        line: controller.context("main").line,
      }),
    );
    jump("recap.stock", "ストック", () =>
      controller.openRight({ view: "stock", target: this.conversation.id }),
    );
    jump("recap.threads", "スレッド", () =>
      controller.openRight({ view: "threads", target: this.conversation.id }),
    );
    let previousCursor = controller.windowPosition("main");
    let previousSeq = this.cursorSeq();
    if (this.main && this.opening) this.tracking.cursor(previousSeq);
    this.cancelCursor = controller.subscribe(() => {
      if (!this.main || !this.opening) return;
      const cursor = controller.windowPosition("main");
      if (!cursor) return;
      const seq = this.cursorSeq();
      const chapterChanged = seq !== previousSeq;
      const moved = cursor.line !== previousCursor?.line || cursor.column !== previousCursor.column;
      previousCursor = cursor;
      previousSeq = seq;
      if (moved || chapterChanged) this.tracking.cursor(seq);
      if (chapterChanged && controller.right.current?.view === "toc" && this.right?.view === "toc")
        this.repaint();
    });
    return () => {
      this.openingRequest++;
      this.cancelCursor?.();
      this.cancelCursor = null;
      this.tracking.stopTimers();
      removers.reverse().forEach((remove) => remove());
      this.main = null;
      this.right = null;
    };
  }
  leave(): void {
    this.tracking.leave();
    forgetOpening(this.storage, this.conversation.id);
    this.opening = null;
    this.rememberedPrevious = false;
    this.position = null;
    this.selectedWhileLoading = null;
    this.conversation.unreadSeq = null;
  }
  pagehide(): void {
    this.tracking.leave();
  }
  visibility(visible: boolean): void {
    this.tracking.visibility(visible);
  }
  received(): void {
    if (!this.main || !this.opening) return;
    this.tracking.received(this.conversation.receivedThrough());
  }
  changed(): void {
    this.received();
    const view = this.conversation.controller.right.current;
    if (
      view?.target === this.conversation.id &&
      ["recent", "toc", "decisions"].includes(view.view)
    ) {
      const current = view.view as RecapView;
      void this.loadView(current).then(() => {
        if (this.right?.view === current) this.repaint();
      });
    }
  }
  private async loadView(view: RecapView): Promise<void> {
    const request = (this.requests[view] ?? 0) + 1;
    this.requests[view] = request;
    try {
      if (view === "recent") {
        const value = await this.api.recent(this.conversation.id);
        if (this.requests[view] === request) this.recent = value;
      }
      if (view === "toc") {
        const value = await this.api.toc(this.conversation.id);
        if (this.requests[view] === request) this.toc = value;
      }
      if (view === "decisions") {
        const value = await this.api.decisions(this.conversation.id);
        if (this.requests[view] === request) this.decisions = value;
      }
      if (this.requests[view] === request) delete this.failures[view];
    } catch (error) {
      if (this.requests[view] === request)
        this.failures[view] = error instanceof Error ? error.message : "取得できませんでした";
    }
  }
  private beginRightOpening(): () => boolean {
    const { controller } = this.conversation;
    const request = ++this.openingRequest;
    const revision = controller.right.openingRevision();
    const url = controller.options.url;
    const main = this.main;
    return () =>
      main !== null &&
      this.main === main &&
      request === this.openingRequest &&
      revision === controller.right.openingRevision() &&
      url === controller.options.url;
  }
  async open(view: RecapView, focus = true, current = this.beginRightOpening()): Promise<void> {
    await this.loadView(view);
    const controller = this.conversation.controller;
    if (!current()) return;
    const mounted = this.right?.view === view;
    this.mountReady = mounted ? null : view;
    controller.openRight({ view, target: this.conversation.id });
    if (mounted) this.repaint();
    if (!focus) controller.focus("main");
  }
  bindRight(view: RecapView, handle: BufferHandle): void {
    this.right = { view, handle };
    if (this.mountReady === view) this.mountReady = null;
    else
      void this.loadView(view).then(() => {
        if (this.right?.handle === handle) this.repaint();
      });
  }
  private repaint(): void {
    if (this.right) this.right.handle.replaceAll(this.lines(this.right.view));
  }
  private row(text: string, seq: number | null, id?: string, seqLine?: number): LineInfo {
    return {
      kind: "text",
      text,
      action: "recap.jump",
      ...(seq === null ? {} : { seq }),
      ...(id ? { id } : {}),
      ...(seqLine === undefined ? {} : { seqLine }),
    };
  }
  lines(view: RecapView): LineInfo[] {
    return this.viewLines(view).flatMap((line) =>
      line.text.split("\n").map((text) => ({ ...line, text })),
    );
  }
  private viewLines(view: RecapView): LineInfo[] {
    if (view === "recent") {
      const data = this.recent;
      if (!data) return [{ kind: "note", text: this.failures[view] ?? "読み込み中" }];
      const rows: LineInfo[] = [
        {
          kind: "heading",
          text: `判断すること ${data.questions.length + (data.pendingPermission ? 1 : 0)}`,
        },
        ...data.questions.map((question) =>
          this.row(question.text, question.seq, `question:${question.id}`),
        ),
      ];
      if (data.pendingPermission)
        rows.push(
          this.row(
            `許可の確認: ${data.pendingPermission.toolName}(${data.pendingPermission.summary})`,
            data.pendingPermission.seq,
          ),
        );
      if (!data.questions.length && !data.pendingPermission)
        rows.push({ kind: "note", text: "ありません" });
      rows.push({ kind: "heading", text: "自分の最後の発言" });
      if (data.lastUserMessage)
        rows.push(this.row(data.lastUserMessage.text, data.lastUserMessage.seq));
      rows.push({ kind: "heading", text: "書きかけ" });
      if (data.draft.exists)
        rows.push({ kind: "text", text: "入力の書きかけ (i で続きを書く)", action: "recap.draft" });
      rows.push(
        { kind: "text", text: `ストック ${data.counts.stock} 件`, action: "recap.stock" },
        {
          kind: "text",
          text: `スレッド ${data.counts.threads} 件 (動いているもの ${data.counts.activeThreads} 件)`,
          action: "recap.threads",
        },
      );
      if (data.counts.queue)
        rows.push({ kind: "text", text: `届く前の指示 ${data.counts.queue} 件` });
      rows.push({ kind: "heading", text: "遡る" });
      if (this.position?.unreadSeq !== null && this.position?.unreadSeq !== undefined)
        rows.push(this.row("未読の先頭へ", this.position.unreadSeq));
      rows.push(
        this.row("前回読んでいた位置へ", this.opening?.lastPosition ?? null),
        { kind: "text", text: "目次", action: "recap.open-toc" },
        { kind: "text", text: "決まったこと", action: "recap.open-decisions" },
      );
      return rows;
    }
    if (view === "toc") {
      const data = this.toc;
      if (!data) return [{ kind: "note", text: this.failures[view] ?? "読み込み中" }];
      const seq = this.cursorSeq();
      const rows = data.chapters.flatMap((chapter) => [
        this.row(
          `${chapter.position} ${chapter.title}${seq !== null && seq >= chapter.startSeq && (chapter.endSeq === null || seq <= chapter.endSeq) ? "  いまここ" : ""}`,
          chapter.startSeq,
          `chapter:${chapter.position}`,
        ),
        ...chapter.decisions.map((item) => this.row(`決定: ${item.text}`, chapter.startSeq)),
      ]);
      if (!data.chapters.length)
        rows.push({ kind: "note", text: "最初の応答が終わると、目次ができます。" });
      rows.push({ kind: "note", text: "章の名前は AI が付けます。/ で検索できます。" });
      return [...rows, ...this.status(data.state)];
    }
    if (view === "decisions") {
      const data = this.decisions;
      if (this.failures[view]) return [{ kind: "note", text: this.failures[view] }];
      if (!data) return [{ kind: "note", text: "読み込み中" }];
      const rows = data.items.map((item): LineInfo => ({
        ...this.row(
          `${labels[item.kind]}: ${item.text}${item.kind === "rejected" && item.reason !== null ? ` — ${item.reason}` : ""}${item.changedTo ? ` → 変わった先: ${data.items.find((next) => next.id === item.changedTo)?.text ?? item.changedTo}` : ""}`,
          item.seq,
          `decision:${item.id}`,
        ),
        ...(item.kind === "pending" ? { tone: "wait" } : {}),
      }));
      if (!data.items.length) rows.push({ kind: "note", text: "まだ決まったことはありません。" });
      rows.push({ kind: "note", text: `リポジトリの ${data.path} に保存しています。` });
      return [...rows, ...this.status(data.state)];
    }
    const result = searchRecap(
      {
        chapters:
          this.toc?.chapters.map((chapter) => ({ text: chapter.title, seq: chapter.startSeq })) ??
          [],
        decisions:
          this.decisions?.items.map((item) => ({
            text: `${labels[item.kind]}: ${item.text}${item.reason === null ? "" : ` — ${item.reason}`}`,
            seq: item.seq,
          })) ?? [],
        body: this.conversation
          .searchLines()
          .filter((line) => line.seq !== undefined)
          .map((line) => ({
            text: line.text,
            seq: line.seq!,
            ...(line.seqLine === undefined ? {} : { seqLine: line.seqLine }),
          })),
      },
      this.query,
    );
    return (
      [
        ["章", result.chapters],
        ["決まったこと", result.decisions],
        ["本文", result.body],
      ] as const
    ).flatMap(([title, hits]) => [
      {
        kind: "heading" as const,
        text: `${title} ${hits.length + (title === "本文" ? result.remaining : 0)}`,
      },
      ...hits.map((hit) => this.row(hit.text, hit.seq, undefined, hit.seqLine)),
      ...(title === "本文" && result.remaining
        ? [{ kind: "note" as const, text: `ほか ${result.remaining} 件` }]
        : []),
    ]);
  }
  private status(state: RecapResponse["state"]): LineInfo[] {
    if (state.failedAt !== null)
      return [
        {
          kind: "note",
          text: `目次を更新できませんでした (${new Date(state.failedAt).toLocaleString("ja-JP")})`,
        },
        { kind: "menu", text: "目次を作り直す", action: "recap.rebuild" },
      ];
    return state.updating ? [{ kind: "note", text: "最後の往復を反映しています" }] : [];
  }
  private selectedJump(): void {
    const line = this.conversation.controller.currentLine();
    if (line?.seq === undefined) {
      this.conversation.controller.notify("根拠の発言がありません");
      return;
    }
    const events = this.conversation.eventRecords();
    const event = events.find((event) => event.seq === line.seq);
    if (event?.type === "diff") this.conversation.expandDiff(event.seq, true);
    let seqLine = line.seqLine;
    if (line.id?.startsWith("question:")) {
      if (event?.type === "assistant_text") {
        const offset = event.payload.text.split("\n").findIndex((text) => text === line.text);
        if (offset >= 0) seqLine = offset;
      } else if (event?.type === "question") {
        const choice = this.recent?.questions
          .filter((question) => question.seq === event.seq && question.kind === "choice")
          .findIndex((question) => line.id === `question:${question.id}`);
        if (choice !== undefined && choice >= 0)
          seqLine = this.conversation
            .bodyLines()
            .filter((candidate) => candidate.seq === event.seq && candidate.kind === "ask")[
            choice
          ]?.seqLine;
      }
    }
    const index =
      seqLine === undefined ? this.findLine(line.seq) : this.main?.findSeq(line.seq, seqLine);
    this.conversation.controller.focus("main");
    if (index !== null && index !== undefined) this.main?.jumpTo(index);
  }
  private async moveChapter(position: number, seq: number, base?: Chapter): Promise<void> {
    let chapter = base;
    if (!chapter) {
      try {
        chapter = (await this.api.toc(this.conversation.id)).chapters.find(
          (chapter) => chapter.position === position,
        );
      } catch (error) {
        throw new CommandRetry(
          error instanceof Error ? error.message : "目次を読み込めませんでした",
          () => this.moveChapter(position, seq),
        );
      }
    }
    if (!chapter) throw new Error("章か本文の行を選んでください");
    try {
      this.toc = await this.api.patchToc(this.conversation.id, position, {
        startSeq: seq,
        base: { title: chapter.title, startSeq: chapter.startSeq },
      });
    } catch (error) {
      const latest = conflict(error)
        ? (await this.reloadToc())?.chapters.find((chapter) => chapter.position === position)
        : chapter;
      throw new CommandRetry(
        error instanceof Error ? error.message : "目次を保存できませんでした",
        () => this.moveChapter(position, seq, latest),
      );
    }
    this.repaint();
  }
  private async reloadToc(): Promise<TocResponse | null> {
    const latest = await this.api.toc(this.conversation.id).catch(() => null);
    if (latest) {
      this.toc = latest;
      this.repaint();
    }
    return latest;
  }
  private async reloadDecisions(): Promise<DecisionsResponse | null> {
    const latest = await this.api.decisions(this.conversation.id).catch(() => null);
    if (latest) {
      this.decisions = latest;
      this.repaint();
    }
    return latest;
  }
  private async edit(): Promise<void> {
    const controller = this.conversation.controller;
    const id = controller.currentLine()?.id;
    const chapter = this.toc?.chapters.find((chapter) => id === `chapter:${chapter.position}`);
    const decisions = this.decisions;
    const item = decisions?.items.find((item) => id === `decision:${item.id}`);
    if (controller.context().view === "toc" && chapter) {
      let base: Chapter | undefined = chapter;
      controller.openPrompt({
        label: "章の名前",
        target: `会話: ${this.conversation.snapshot().data!.conversation.title}`,
        verb: "保存する",
        initialText: chapter.title,
        close: () => {},
        submit: async (title) => {
          if (!base) throw new Error("編集している章が見つかりません");
          try {
            this.toc = await this.api.patchToc(this.conversation.id, chapter.position, {
              title,
              base: { title: base.title, startSeq: base.startSeq },
            });
            this.repaint();
          } catch (error) {
            if (conflict(error)) {
              const latest = await this.reloadToc();
              if (latest)
                base = latest.chapters.find((value) => value.position === chapter.position);
            }
            throw error;
          }
        },
      });
    } else if (controller.context().view === "decisions" && item && decisions) {
      let base = decisions;
      controller.openPrompt({
        label: "決まったこと",
        target: `会話: ${this.conversation.snapshot().data!.conversation.title}`,
        verb: "保存する",
        initialText: `${labels[item.kind]}: ${item.text}`,
        close: () => {},
        submit: async (text) => {
          const match = /^(決定|採らなかった案|保留):\s*([\s\S]+)$/.exec(text);
          if (!match)
            throw new Error("決定: 内容、採らなかった案: 内容、保留: 内容 の形で書いてください");
          if (!base.items.some((value) => value.id === item.id))
            throw new Error("編集している項目が見つかりません");
          const kind =
            match[1] === "決定" ? "decision" : match[1] === "保留" ? "pending" : "rejected";
          try {
            await this.saveItems(
              base,
              base.items.map((value) =>
                value.id === item.id ? { ...value, kind, text: match[2] } : value,
              ),
            );
          } catch (error) {
            if (conflict(error)) base = (await this.reloadDecisions()) ?? base;
            throw error;
          }
        },
      });
    }
  }
  private async saveItems(base: DecisionsResponse, items: Decision[]): Promise<void> {
    this.decisions = await this.api.putDecisions(this.conversation.id, {
      baseHash: base.hash,
      items,
    });
    this.repaint();
  }
  private async remove(): Promise<void> {
    const base = this.decisions;
    if (this.conversation.controller.context().view !== "decisions" || !base) return;
    const id = this.conversation.controller.currentLine()?.id;
    const index = base.items.findIndex((item) => id === `decision:${item.id}`);
    if (index < 0) return;
    const item = base.items[index];
    const links = base.items.filter((value) => value.changedTo === item.id);
    try {
      await this.saveItems(
        base,
        base.items
          .filter((value) => value.id !== item.id)
          .map((value) => (value.changedTo === item.id ? { ...value, changedTo: null } : value)),
      );
      this.undo = {
        item,
        before: base.items.slice(0, index).map((value) => value.id),
        after: base.items.slice(index + 1).map((value) => value.id),
        links,
      };
    } catch (error) {
      if (conflict(error)) await this.reloadDecisions();
      throw error;
    }
  }
  private async restore(): Promise<void> {
    const undo = this.undo;
    const base = this.decisions;
    if (!undo || !base || this.conversation.controller.context().view !== "decisions") return;
    if (base.items.some((item) => item.id === undo.item.id))
      throw new Error("同じ番号の項目があるため、削除した項目を戻せません");
    const items = base.items.map((item) => {
      const link = undo.links.find((link) => link.id === item.id);
      return link &&
        item.changedTo === null &&
        item.kind === link.kind &&
        item.text === link.text &&
        item.reason === link.reason &&
        item.seq === link.seq
        ? { ...item, changedTo: undo.item.id }
        : item;
    });
    const before = undo.before.findLast((id) => items.some((item) => item.id === id));
    const after = undo.after.find((id) => items.some((item) => item.id === id));
    const index = before
      ? items.findIndex((item) => item.id === before) + 1
      : after
        ? items.findIndex((item) => item.id === after)
        : Math.min(undo.before.length, items.length);
    const item =
      undo.item.changedTo !== null && !items.some((value) => value.id === undo.item.changedTo)
        ? { ...undo.item, changedTo: null }
        : undo.item;
    items.splice(index, 0, item);
    try {
      await this.saveItems(base, items);
      this.undo = null;
    } catch (error) {
      if (conflict(error)) await this.reloadDecisions();
      throw error;
    }
  }
}
